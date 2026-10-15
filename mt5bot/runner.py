"""MT5-Runner: verbindet sich mit dem laufenden MetaTrader-5-Terminal und führt alle aktiven Profile aus.

Ablauf (wie bei den Beispiel-Bots, aber mit mehreren Profilen über EINE Verbindung):
  1. Verbindung zum Terminal, SICHERHEITSCHECK: auf Echtgeld-Konten wird nicht gestartet (ALLOW_REAL_ACCOUNT=False)
  2. Pro Profil/Markt bei jeder neu geschlossenen Kerze: Ausstiegssignal prüfen, dann Einstiegssignal
  3. Order mit Stop-Loss UND Take-Profit, Lotgröße über order_calc_profit des Brokers (1 % Risiko), Schutz-Wächter
  4. Tagesverlust-Limit, Positionslimit, Kill-Switch-Datei, Journal (CSV), Lebenszeichen im Log
Das MetaTrader5-Paket gibt es nur für Windows. Der Runner bekommt das Modul von außen (Tests nutzen eine Attrappe).
"""
from __future__ import annotations

import csv
import json
import logging
import math
import os
import queue
import secrets
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

from . import config as default_config
from . import history
from .signals import atr_last, make_strategy, replay_signals

TF_NAMES = ("M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1")
# Häufige Ablehnungsgründe von MetaTrader in verständlichem Deutsch
RETCODE_TEXT = {
    10027: "Algo-Handel im MetaTrader-Terminal ist AUS → oben auf den Knopf 'Algo-Handel' klicken (grün) und Extras → Optionen → Experten → 'Algo-Handel zulassen'",
    10026: "Algo-Handel ist vom Server/Broker für dieses Konto deaktiviert",
    10018: "Markt ist geschlossen",
    10019: "Nicht genug Guthaben/Margin für diese Order",
    10014: "Ungültige Ordergröße (Lots)",
    10015: "Ungültiger Preis",
    10016: "Ungültige Stop-Loss/Take-Profit-Abstände (zu nah am Kurs)",
    10030: "Der Broker unterstützt diese Ausführungsart nicht",
    10024: "Zu viele Anfragen",
    10031: "Keine Verbindung zum Handelsserver",
    10032: "Handel auf dem Echtgeld-Konto nicht erlaubt",
    10017: "Handel für dieses Symbol ist deaktiviert",
}
log = logging.getLogger("mt5bot")


def setup_logging(path: str) -> None:
    fmt = logging.Formatter("%(asctime)s | %(message)s", "%Y-%m-%d %H:%M:%S")
    log.setLevel(logging.INFO)
    if not log.handlers:
        for h in (logging.StreamHandler(sys.stdout), logging.FileHandler(path, encoding="utf-8")):
            h.setFormatter(fmt)
            log.addHandler(h)


class Runner:
    def __init__(self, mt5, cfg=default_config, folder: str | Path = "."):
        self.mt5, self.cfg, self.folder = mt5, cfg, Path(folder)
        self.profiles = []
        self.events: list[dict] = []          # Ereignisse seit dem letzten Stundenbericht
        self.started = datetime.now().astimezone()
        self.errors_since_report: list[str] = []
        self.tg = None
        self.last_equity_log = 0.0
        self.web_cmds: queue.Queue = queue.Queue()
        self.web_results: dict[str, dict] = {}
        self.symbols: dict[str, str] = {}      # Konfig-Name -> Broker-Name
        self.last_bar: dict[tuple, object] = {}
        self.halted_day: str | None = None
        self.state = self._load_state()
        self.tf = {n: getattr(mt5, f"TIMEFRAME_{n}", None) for n in TF_NAMES}
        for p in cfg.PROFILES:
            if not p.get("enabled", True):
                continue
            strat = make_strategy(p["strategy"], p.get("allow_short", False))
            if not 0 < p.get("risk_percent", 1.0) <= 2.0:
                raise ValueError(f"{p['name']}: risk_percent muss zwischen 0 und 2 liegen")
            for sym, tf in p["markets"].items():
                if tf not in TF_NAMES:
                    raise ValueError(f"{p['name']}: Zeitrahmen {tf} unbekannt ({TF_NAMES})")
            self.profiles.append({**p, "strat": strat})
        magics = [p["magic"] for p in self.profiles] + sorted(self.manual_magics())
        if len(set(magics)) != len(magics):
            raise ValueError("Jedes Profil braucht eine eigene Magic Number")

    # ---------- Protokoll: Entscheidungen und Berichte ----------
    def _logdir(self) -> Path:
        d = self._path(getattr(self.cfg, "LOG_DIR", "logs"))
        d.mkdir(parents=True, exist_ok=True)
        return d

    # ---------- Aktionen (gemeinsam für Telegram und Portal; jede gibt einen lesbaren Ergebnistext zurück) ----------
    def do_close(self, ticket: int, why: str) -> str:
        pos = next((p for p in self.all_positions() if p.ticket == ticket), None)
        if pos is None:
            return f"Trade #{ticket} nicht gefunden (schon geschlossen?)."
        if pos.magic not in {p["magic"] for p in self.profiles} | self.manual_magics():
            return f"Trade #{ticket} gehört nicht zu diesem Bot – bitte im MetaTrader schließen."
        return f"#{ticket} {pos.symbol} geschlossen." if self.close(pos, why) else f"#{ticket}: SCHLIESSEN FEHLGESCHLAGEN – siehe Log/MetaTrader."

    def do_closeall(self, why: str) -> str:
        poss = self.positions()
        n = sum(self.close(p, why) for p in poss)
        return f"{n} von {len(poss)} Trade(s) geschlossen."

    def do_kill(self, why: str) -> str:
        poss = self.positions()
        self.state["paused"] = True
        self._save_state()
        n = sum(self.close(p, why) for p in poss)
        self.event("LIMIT", "Not-Aus", f"{why}: {n} Trade(s) geschlossen, Bot pausiert")
        return f"NOT-AUS: {n} von {len(poss)} Trade(s) geschlossen, neue Trades pausiert."

    def do_pause(self, paused: bool, why: str) -> str:
        self.state["paused"] = paused
        self._save_state()
        self.event("LIMIT", "Pause" if paused else "Fortsetzen", f"{why}: " + ("keine neuen automatischen Trades" if paused else "neue Trades wieder erlaubt"))
        return "PAUSIERT: keine neuen automatischen Trades (offene Positionen bleiben mit Stop/Ziel bestehen)." if paused else "Neue Trades wieder erlaubt."

    def check_manual_open(self, name: str, risk: float) -> str | None:
        """Gibt einen Ablehnungsgrund zurück oder None, wenn manuell eröffnet werden darf."""
        if self.manual_profile() is None:
            return "Manuelles Eröffnen ist abgeschaltet (MANUAL['enabled'] in der Konfiguration)."
        if name not in self.symbols:
            return f"Symbol {name} nicht verfügbar. Verfügbar: {', '.join(sorted(self.symbols))}"
        if not 0 < risk <= 2:
            return "Risiko muss größer 0 und höchstens 2 % sein."
        if not self.day_check():
            return "Tagesverlust-Limit erreicht – keine neuen Trades."
        if len(self.positions()) >= self.cfg.MAX_OPEN_POSITIONS:
            return f"Maximal {self.cfg.MAX_OPEN_POSITIONS} Positionen gleichzeitig – erst eine schließen."
        return None

    def manual_prof(self, name: str, risk: float) -> dict:
        man = self.manual_profile()
        return {**man, "risk_percent": risk, "markets": {name: man["timeframe"]}}

    def do_open(self, direction: str, name: str, risk: float, source: str) -> str:
        bad = self.check_manual_open(name, risk)
        if bad:
            return bad
        ok = self.place(self.manual_prof(name, risk), name, direction, f"Manuell eröffnet ({source}, kein Strategie-Signal)")
        return f"{direction.upper()} {name} eröffnet." if ok else f"{name}: Order NICHT ausgeführt – Details im Log."

    # ---------- Befehle aus dem Portal (Warteschlange, ausgeführt in der Hauptschleife) ----------
    def submit_web_command(self, cmd: dict) -> str:
        cid = secrets.token_hex(6)
        self.web_results[cid] = {"done": False, "text": "wartet …"}
        self.web_cmds.put((cid, cmd))
        if len(self.web_results) > 200:  # alte Ergebnisse aufräumen
            for k in list(self.web_results)[:100]:
                self.web_results.pop(k, None)
        return cid

    def process_web_commands(self) -> None:
        while True:
            try:
                cid, cmd = self.web_cmds.get_nowait()
            except queue.Empty:
                return
            try:
                t = cmd.get("type")
                if t == "close":
                    text = self.do_close(int(cmd["ticket"]), "Portal: Klick")
                elif t == "closeall":
                    text = self.do_closeall("Portal: Klick (alle)")
                elif t == "kill":
                    text = self.do_kill("Portal: Klick (Not-Aus)")
                elif t == "pause":
                    text = self.do_pause(True, "Portal")
                elif t == "resume":
                    text = self.do_pause(False, "Portal")
                elif t in ("buy", "sell"):
                    text = self.do_open("long" if t == "buy" else "short", str(cmd["symbol"]).upper(), float(cmd.get("risk", 0.5)), "Portal")
                else:
                    text = "Unbekannter Befehl."
            except Exception as e:  # ein Befehl darf den Bot nie stoppen
                log.exception("Portal-Befehl fehlgeschlagen")
                text = f"Fehler: {type(e).__name__}: {e}"
            self.web_results[cid] = {"done": True, "text": text}
            self.write_snapshot()  # Anzeige sofort aktualisieren

    def tg_notify(self, text: str) -> None:
        if self.tg is not None:
            try:
                self.tg.notify(text)
            except Exception:
                log.exception("Telegram-Nachricht nicht gesendet")

    @staticmethod
    def fmt_checks(checks) -> str:
        return "\n".join(f"      {'✔' if ok else '✘'} {text}" for ok, text in (checks or []))

    def event(self, kind: str, head: str, text: str = "", checks=None) -> None:
        """Hält eine Entscheidung fest: sofort in entscheidungen_<Datum>.log, außerdem für den nächsten Stundenbericht."""
        now = datetime.now().astimezone()
        self.events.append({"t": now.isoformat(), "kind": kind, "head": head, "text": text, "checks": list(checks or [])})
        line = f"{now:%Y-%m-%d %H:%M:%S} | {kind:<10} | {head}" + (f" | {text}" if text else "")
        extra = self.fmt_checks(checks)
        if kind in getattr(self.cfg, "TELEGRAM_NOTIFY", ("KAUF", "VERKAUF", "FEHLER", "LIMIT", "BLOCKIERT")):
            self.tg_notify(f"{kind} – {head}" + (f"\n{text}" if text else "") + (("\n" + extra.replace("      ", "")) if kind == "KAUF" else ""))
        try:
            with open(self._logdir() / f"entscheidungen_{now:%Y-%m-%d}.log", "a", encoding="utf-8") as fh:
                fh.write(line + "\n" + (extra + "\n" if extra else ""))
        except OSError:
            log.exception("Entscheidungsprotokoll konnte nicht geschrieben werden")

    def build_report(self, now: datetime) -> str:
        mt5, L = self.mt5, []
        acc = mt5.account_info()
        sep = "=" * 78
        L += [sep, f"BERICHT {now:%Y-%m-%d %H:%M} (Ortszeit)   |   Bot läuft seit {self.started:%Y-%m-%d %H:%M}", sep, ""]
        L.append("1. KONTO UND ZUSTAND")
        if acc:
            start = self.state.get("start_equity")
            pnl = f"{acc.equity - start:+.2f} ({(acc.equity - start) / start * 100:+.2f} %)" if start else "–"
            L.append(f"   Konto {acc.login} ({acc.server}), {'DEMO' if acc.trade_mode == mt5.ACCOUNT_TRADE_MODE_DEMO else 'ECHTGELD'}")
            L.append(f"   Kapital {acc.equity:.2f} {acc.currency}  |  Tagesbeginn {start if start is not None else '–'}  |  Tages-P&L {pnl}")
        else:
            L.append("   Kein Konto abrufbar (Verbindung weg?)")
        L.append(f"   Tageslimit: {'ERREICHT – keine neuen Trades' if self.halted_day else 'frei'} (Grenze {self.cfg.DAILY_LOSS_LIMIT_PCT} %)  |  "
                 f"Kill-Switch: {'AKTIV' if self.kill_requested() else 'aus'}  |  Max. Positionen {self.cfg.MAX_OPEN_POSITIONS}")
        for prof in self.profiles:
            L.append(f"   Profil '{prof['name']}': {prof['strat'].name}  | Märkte: " + ", ".join(f"{n} {t}" for n, t in prof["markets"].items())
                     + "  | Risiko {} %, Stop {:g}×ATR, Ziel {:g}R".format(prof.get("risk_percent", 1.0), *self.exit_params(prof)))
        if self.errors_since_report:
            L.append(f"   Fehler seit dem letzten Bericht: {len(self.errors_since_report)}, zuletzt: {self.errors_since_report[-1]}")
        L.append("")
        L.append("2. OFFENE POSITIONEN (mit Begründung)")
        poss = self.all_positions()
        if not poss:
            L.append("   keine")
        for pos in poss:
            label, own = self.bot_name(pos.magic)
            rec = self.state.get("trades", {}).get(str(pos.ticket), {})
            r_now, r_max = self.r_values(pos)
            L.append(f"   #{pos.ticket} {pos.symbol} {'LONG' if pos.type == mt5.POSITION_TYPE_BUY else 'SHORT'} {pos.volume} Lots  [{label}{'' if own else ' – nicht von diesem Bot verwaltet'}]")
            L.append(f"      Einstieg {rec.get('entry', pos.price_open)}  Stop {pos.sl}  Ziel {pos.tp}  Kurs {self._price(pos)}  Gewinn {getattr(pos, 'profit', 0.0):+.2f}"
                     + (f"  R {r_now:+.2f} (max {r_max:+.2f})" if r_now is not None else ""))
            if rec.get("reason"):
                L.append("      WARUM GEKAUFT: " + rec["reason"].replace("\n", "\n      "))
        L.append("")
        L.append("3. EREIGNISSE SEIT DEM LETZTEN BERICHT")
        if not self.events:
            L.append("   keine neue Kerze ausgewertet, keine Order")
        trades = [e for e in self.events if e["kind"] in ("KAUF", "VERKAUF", "SCHLIESSEN", "FEHLER", "LIMIT", "BLOCKIERT")]
        for e in self.events:
            t = datetime.fromisoformat(e["t"])
            L.append(f"   {t:%H:%M:%S} {e['kind']:<10} {e['head']}" + (f" – {e['text']}" if e["text"] else ""))
            if e["checks"] and e["kind"] in ("KAUF", "KEIN KAUF", "BLOCKIERT"):
                L.append(self.fmt_checks(e["checks"]).replace("      ", "         "))
        L.append(f"   Summe: {sum(e['kind'] == 'KAUF' for e in self.events)} Kauf/Käufe, {sum(e['kind'] in ('VERKAUF', 'SCHLIESSEN') for e in self.events)} Schließung(en), "
                 f"{sum(e['kind'] == 'KEIN KAUF' for e in self.events)} Auswertung(en) ohne Kauf, {len(trades) - sum(e['kind'] in ('KAUF', 'VERKAUF', 'SCHLIESSEN') for e in trades)} Hinweis(e)/Fehler")
        L.append("")
        L.append("4. MARKTANALYSE JETZT (Warum würde er kaufen / warum nicht)")
        for prof in self.profiles:
            for name, tf in prof["markets"].items():
                df = self.closed_bars(name, tf)
                head = f"   [{prof['name']}] {name} {tf}"
                if df is None:
                    L.append(f"{head}: keine Daten (Markt geschlossen oder Symbol fehlt)")
                    continue
                try:
                    extra = {r: self.closed_bars(r, tf) for r in prof["strat"].needs}
                    checks = prof["strat"].explain(df, extra)
                    sig = prof["strat"].entry(df, extra)
                    missing = [t for ok, t in checks if not ok]
                    L.append(f"{head}  (letzte geschlossene Kerze {df.index[-1]:%Y-%m-%d %H:%M})")
                    L.append(f"      Ergebnis: {'KAUFSIGNAL – ' + sig.upper() if sig else 'kein Signal'}"
                             + (f"  |  es fehlt: {len(missing)} Bedingung(en)" if missing and not sig else ""))
                    L.append(self.fmt_checks(checks))
                except Exception as e:  # Bericht darf nie am Detail scheitern
                    L.append(f"{head}: Analyse nicht möglich ({e})")
        nxt = self._next_bar_time()
        L += ["", f"Nächste Kerze/Entscheidung: {nxt or 'noch unbekannt'}", ""]
        return "\n".join(L)

    def maybe_report(self, force: bool = False) -> bool:
        now = datetime.now().astimezone()
        last = self.state.get("last_report")
        due = force or not last or (now - datetime.fromisoformat(last)).total_seconds() >= getattr(self.cfg, "REPORT_MINUTES", 60) * 60
        if not due:
            return False
        text = self.build_report(now)
        with open(self._logdir() / f"bericht_{now:%Y-%m-%d}.txt", "a", encoding="utf-8") as fh:
            fh.write(text + "\n")
        self.state["last_report"] = now.isoformat()
        self._save_state()
        self.events.clear()
        self.errors_since_report.clear()
        log.info(f"Bericht geschrieben: {self._logdir() / ('bericht_' + now.strftime('%Y-%m-%d') + '.txt')}")
        return True

    # ---------- Zustand ----------
    def _path(self, name: str) -> Path:
        return self.folder / name

    def _load_state(self) -> dict:
        try:
            return json.loads(self._path(self.cfg.STATE_FILE).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _save_state(self) -> None:
        tmp = self._path(self.cfg.STATE_FILE).with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state), encoding="utf-8")
        os.replace(tmp, self._path(self.cfg.STATE_FILE))

    def journal(self, row: dict) -> None:
        f = self._path(self.cfg.JOURNAL_FILE)
        new = not f.exists()
        cols = ["zeit", "ereignis", "profil", "symbol", "richtung", "lots", "preis", "sl", "tp", "risiko", "gewinn", "grund", "equity"]
        with open(f, "a", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=cols)
            if new:
                w.writeheader()
            w.writerow({c: row.get(c, "") for c in cols})

    # ---------- Verbindung ----------
    def connect(self) -> None:
        kw = {}
        if self.cfg.MT5_LOGIN:
            kw = dict(login=self.cfg.MT5_LOGIN, password=self.cfg.MT5_PASSWORD, server=self.cfg.MT5_SERVER)
        if getattr(self.cfg, "MT5_TERMINAL_PATH", None):
            kw["path"] = self.cfg.MT5_TERMINAL_PATH  # startet das Terminal selbst, falls es nicht läuft
        if not self.mt5.initialize(**kw):
            raise RuntimeError(f"MT5-Initialisierung fehlgeschlagen: {self.mt5.last_error()} – läuft das Terminal und ist es eingeloggt?")
        acc = self.mt5.account_info()
        if acc is None:
            self.mt5.shutdown()
            raise RuntimeError("Kein Konto gefunden – im MT5-Terminal einloggen.")
        demo = acc.trade_mode == self.mt5.ACCOUNT_TRADE_MODE_DEMO
        log.info(f"Verbunden: Konto {acc.login} ({acc.server}), {'DEMO' if demo else 'ECHTGELD'}, Balance {acc.balance:.2f} {acc.currency}")
        if not demo and not self.cfg.ALLOW_REAL_ACCOUNT:
            self.mt5.shutdown()
            raise RuntimeError("SICHERHEITSSTOPP: Echtgeld-Konto erkannt, ALLOW_REAL_ACCOUNT ist False.")
        self.ensure_symbols()

    def ensure_symbols(self) -> None:
        wanted = {s for p in self.profiles for s in p["markets"]} | {r for p in self.profiles for r in p["strat"].needs}
        wanted |= set((getattr(self.cfg, "MANUAL", None) or {}).get("symbols", []))
        for name in sorted(wanted):
            base = [name] + [a for a in self.cfg.SYMBOL_ALIASES.get(name, []) if a != name]
            sfx = getattr(self.cfg, "SYMBOL_SUFFIXES", [""])
            for cand in dict.fromkeys(b + x for b in base for x in sfx):  # reihenfolge-erhaltend, ohne Doppelte
                info = self.mt5.symbol_info(cand)
                if info is not None:
                    if not info.visible:
                        self.mt5.symbol_select(cand, True)
                    self.symbols[name] = cand
                    log.info(f"{name}: aktiv als {cand}")
                    break
            else:
                log.warning(f"{name}: beim Broker nicht gefunden – wird übersprungen (Symbolname in SYMBOL_ALIASES eintragen)")
        if not self.symbols:
            raise RuntimeError("Keines der Symbole ist beim Broker verfügbar.")

    # ---------- Daten & Positionen ----------
    def closed_bars(self, name: str, tf: str) -> pd.DataFrame | None:
        sym = self.symbols.get(name)
        return None if sym is None else self.closed_bars_raw(sym, tf)

    def closed_bars_raw(self, sym: str, tf: str) -> pd.DataFrame | None:
        rates = self.mt5.copy_rates_from_pos(sym, self.tf[tf], 0, self.cfg.BARS_HISTORY)
        if rates is None or len(rates) < 10:
            return None
        df = pd.DataFrame(rates)
        df["time"] = pd.to_datetime(df["time"], unit="s", utc=True)
        df = df.set_index("time")
        df["volume"] = df["tick_volume"] if "tick_volume" in df else 1.0
        return df[["open", "high", "low", "close", "volume"]].iloc[:-1]  # letzte Zeile = laufende Kerze

    def manual_magics(self) -> set:
        man = self.manual_profile()
        return {man["magic"]} if man else set()

    def all_positions(self):
        """Alle Positionen des Kontos – auch von anderen Bots oder manuell (nur zur Anzeige, verwaltet werden nur eigene)."""
        return list(self.mt5.positions_get() or [])

    def bot_name(self, magic: int) -> tuple[str, bool]:
        """(Anzeigename, gehört zu diesem Prozess?) anhand der Magic Number."""
        own = next((p for p in self.profiles if p["magic"] == magic), None)
        if own:
            return own["name"], True
        if magic in self.manual_magics():
            return "manuell (Telegram)", True
        cfgp = next((p for p in self.cfg.PROFILES if p["magic"] == magic), None)
        if cfgp:
            return f"{cfgp['name']} (extern)", False
        known = getattr(self.cfg, "KNOWN_BOTS", {}).get(magic)
        return (known, False) if known else (("manuell", False) if magic == 0 else (f"Magic {magic}", False))

    def positions(self, magic: int | None = None, name: str | None = None):
        pos = self.mt5.positions_get() or []
        magics = {p["magic"] for p in self.profiles} | self.manual_magics()
        sym = self.symbols.get(name) if name else None
        return [p for p in pos if (p.magic == magic if magic is not None else p.magic in magics) and (sym is None or p.symbol == sym)]

    # ---------- Orders ----------
    def calc_lots(self, sym: str, direction: str, entry: float, sl: float, risk_percent: float):
        mt5 = self.mt5
        acc, info = mt5.account_info(), mt5.symbol_info(sym)
        if acc is None or info is None:
            return None
        risk = acc.equity * risk_percent / 100
        otype = mt5.ORDER_TYPE_BUY if direction == "long" else mt5.ORDER_TYPE_SELL

        def loss_for(vol):
            r = mt5.order_calc_profit(otype, sym, vol, entry, sl)
            return None if r is None else abs(r)

        per_lot = loss_for(1.0)
        if not per_lot:
            log.warning(f"{sym}: order_calc_profit fehlgeschlagen ({mt5.last_error()}) – Trade übersprungen.")
            return None
        step = info.volume_step or 0.01
        lots = round(math.floor(risk / per_lot / step) * step, 8)  # ABRUNDEN: lieber etwas weniger Risiko
        lots = min(lots, info.volume_max)
        if lots < info.volume_min:
            mn = loss_for(info.volume_min)
            if mn is None or mn > 2 * risk:
                log.warning(f"{sym}: Mindest-Lot {info.volume_min} würde {mn} riskieren (Ziel {risk:.2f}) – Trade übersprungen.")
                return None
            lots = info.volume_min
        actual = loss_for(lots)
        if actual is None or actual > 1.5 * risk:
            log.warning(f"{sym}: Risikoprüfung fehlgeschlagen ({actual} > 1,5x {risk:.2f}) – Trade abgebrochen.")
            return None
        return lots, actual

    def _send(self, req):
        mt5 = self.mt5
        res = mt5.order_send(req)
        if res is None or res.retcode != mt5.TRADE_RETCODE_DONE:
            req = {**req, "type_filling": mt5.ORDER_FILLING_FOK}  # manche Broker brauchen FOK statt IOC
            res = mt5.order_send(req)
        return res

    def _order_plan(self, prof: dict, name: str, direction: str) -> dict:
        """Berechnet Preis, Stop, Ziel und Lotgröße (1 % Risiko). Wirft RuntimeError mit lesbarem Grund, wenn kein Trade möglich ist."""
        mt5, sym = self.mt5, self.symbols[name]
        info, tick = mt5.symbol_info(sym), mt5.symbol_info_tick(sym)
        df = self.closed_bars(name, prof["markets"][name])
        if info is None or tick is None or df is None:
            raise RuntimeError(f"{sym}: keine Kurse (Markt geschlossen?)")
        mult, rr = self.exit_params(prof)
        stop = atr_last(df) * mult
        if not stop > 0:
            raise RuntimeError(f"{sym}: ATR unbrauchbar")
        stop = max(stop, (info.trade_stops_level or 0) * info.point * 1.1)  # Broker-Mindestabstand
        long = direction == "long"
        price = tick.ask if long else tick.bid
        sl = round(price - stop if long else price + stop, info.digits)
        tp = round(price + stop * rr if long else price - stop * rr, info.digits)
        calc = self.calc_lots(sym, direction, price, sl, prof.get("risk_percent", 1.0))
        if calc is None:
            raise RuntimeError(f"{sym}: Lotgröße nicht berechenbar oder Risiko zu hoch (Konto zu klein?)")
        lots, risk = calc
        return {"sym": sym, "price": price, "sl": sl, "tp": tp, "lots": lots, "risk": risk, "mult": mult, "rr": rr}

    @staticmethod
    def exit_params(prof: dict) -> tuple[float, float]:
        """Stop-Abstand (x ATR) und Ziel (x Stop): die Werte der STRATEGIE haben Vorrang (so wurde getestet), sonst die des Profils."""
        strat = prof.get("strat")
        mult, rr = prof.get("atr_stop_mult", 2.0), prof.get("rr", 2.0)
        if strat is not None and hasattr(strat, "stop_mult"):
            mult, rr = strat.stop_mult(mult), strat.rr(rr)
        return mult, rr

    def plan_order(self, prof: dict, name: str, direction: str) -> str:
        pl = self._order_plan(prof, name, direction)
        return (f"{pl['lots']} Lots @ {pl['price']} | Stop {pl['sl']} | Ziel {pl['tp']}\n"
                f"Risiko {pl['risk']:.2f} ({prof.get('risk_percent', 1.0)} % des Kontos, {pl['mult']:g}xATR, Ziel {pl['rr']:g}R)")

    def manual_profile(self) -> dict | None:
        m = getattr(self.cfg, "MANUAL", None)
        if not m or not m.get("enabled", True):
            return None
        return {"name": "manuell", "magic": m["magic"], "timeframe": m.get("timeframe", "H4"), "risk_percent": m.get("risk_percent", 0.5),
                "atr_stop_mult": m.get("atr_stop_mult", 2.0), "rr": m.get("rr", 2.0)}

    def place(self, prof: dict, name: str, direction: str, why: str) -> bool:
        mt5 = self.mt5
        try:
            pl = self._order_plan(prof, name, direction)
        except RuntimeError as e:
            log.warning(f"{e} – Trade übersprungen.")
            return False
        sym, price, sl, tp, lots, risk = pl["sym"], pl["price"], pl["sl"], pl["tp"], pl["lots"], pl["risk"]
        long = direction == "long"
        req = {"action": mt5.TRADE_ACTION_DEAL, "symbol": sym, "volume": lots, "type": mt5.ORDER_TYPE_BUY if long else mt5.ORDER_TYPE_SELL,
               "price": price, "sl": sl, "tp": tp, "deviation": 20, "magic": prof["magic"], "comment": prof["name"][:20],
               "type_time": mt5.ORDER_TIME_GTC, "type_filling": mt5.ORDER_FILLING_IOC}
        res = self._send(req)
        if not res or res.retcode != mt5.TRADE_RETCODE_DONE:
            code = res.retcode if res else None
            why_txt = RETCODE_TEXT.get(code, f"Retcode {code} (siehe MetaTrader-Journal)") if res else f"keine Antwort vom Terminal ({mt5.last_error()})"
            self.last_order_error = f"{why_txt} [Retcode {code}]"
            log.error(f"{sym}: Order abgelehnt: {why_txt} – es wird KEIN ungeschützter Ersatz-Trade platziert.")
            return False
        acc = mt5.account_info()
        log.info(f"ORDER AUSGEFÜHRT: {direction.upper()} {sym} {lots} Lots @ {res.price} | SL {sl} | TP {tp} | Risiko {risk:.2f} | {prof['name']}")
        self.journal({"zeit": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "ereignis": "OPEN", "profil": prof["name"], "symbol": sym,
                      "richtung": direction, "lots": lots, "preis": res.price, "sl": sl, "tp": tp, "risiko": f"{risk:.2f}",
                      "grund": why, "equity": f"{acc.equity:.2f}" if acc else ""})
        self.enforce_protection(prof, sym, sl, tp)
        self.track_positions()
        mine = [x for x in self.positions(prof["magic"]) if x.symbol == sym]
        if mine:  # Begründung bleibt auch nach einem Neustart erhalten (Bericht: „Warum gekauft“)
            newest = max(mine, key=lambda x: x.ticket)
            tf = prof["markets"].get(self._market_of(prof, newest) or "", "")
            self.state.setdefault("trades", {}).setdefault(str(newest.ticket), {})["reason"] = (
                f"{direction.upper()} {sym} {tf} ({prof['name']}): {why}\n"
                f"Risiko {risk:.2f} (= {prof.get('risk_percent', 1.0)} % des Kontos), Stop {sl} ({pl['mult']:g}xATR), Ziel {tp} ({pl['rr']:g}R)")
            self._save_state()
        return True

    def enforce_protection(self, prof: dict, sym: str, sl: float, tp: float) -> None:
        """Eine Position ohne Stop-Loss/Take-Profit darf nicht bestehen bleiben: nachrüsten, sonst sofort schließen."""
        mt5 = self.mt5
        for pos in [p for p in self.positions(prof["magic"]) if p.symbol == sym]:
            if pos.sl > 0 and pos.tp > 0:
                continue
            log.warning(f"{sym}: Position {pos.ticket} ohne vollständigen Schutz – rüste nach.")
            res = mt5.order_send({"action": mt5.TRADE_ACTION_SLTP, "symbol": sym, "position": pos.ticket, "sl": sl, "tp": tp, "magic": prof["magic"]})
            if not res or res.retcode != mt5.TRADE_RETCODE_DONE:
                log.error(f"{sym}: Schutz nicht setzbar – Position wird sofort geschlossen.")
                self.close(pos, "Notschluss: kein Schutz")

    def close(self, pos, why: str) -> bool:
        mt5 = self.mt5
        tick = mt5.symbol_info_tick(pos.symbol)
        buy = pos.type == mt5.POSITION_TYPE_BUY
        req = {"action": mt5.TRADE_ACTION_DEAL, "symbol": pos.symbol, "volume": pos.volume, "type": mt5.ORDER_TYPE_SELL if buy else mt5.ORDER_TYPE_BUY,
               "position": pos.ticket, "price": (tick.bid if buy else tick.ask) if tick else 0.0, "deviation": 50, "magic": pos.magic,
               "comment": "close", "type_time": mt5.ORDER_TIME_GTC, "type_filling": mt5.ORDER_FILLING_IOC}
        res = self._send(req)
        ok = bool(res and res.retcode == mt5.TRADE_RETCODE_DONE)
        log.info(f"{'GESCHLOSSEN' if ok else 'SCHLIESSEN FEHLGESCHLAGEN'}: {pos.symbol} #{pos.ticket} – {why}")
        if ok:
            rec = self.state.setdefault("trades", {}).setdefault(str(pos.ticket), {})
            rec["close_reason"] = why
            rec["close_price"] = getattr(res, "price", None) or None
            self.track_positions()  # Abschluss sofort festhalten (Ergebnis, R, Auswertung)
        else:
            self.event("FEHLER", f"{pos.symbol} #{pos.ticket}", f"Schließen fehlgeschlagen: {why} (Retcode {res.retcode if res else '?'})")
        return ok

    # ---------- Tageslimit & Kill-Switch ----------
    def day_check(self) -> bool:
        """True, wenn heute noch neue Trades erlaubt sind."""
        acc = self.mt5.account_info()
        if acc is None:
            return False
        day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        if self.state.get("day") != day or self.state.get("login") != acc.login:  # neuer Tag ODER anderes Konto: Tagesanfang neu setzen
            self.state.update(day=day, start_equity=acc.equity, login=acc.login)
            self._save_state()
            self.halted_day = None
        start = self.state.get("start_equity", acc.equity)
        if start > 0 and (start - acc.equity) / start * 100 >= self.cfg.DAILY_LOSS_LIMIT_PCT:
            if self.halted_day != day:
                log.warning(f"TAGESVERLUST-LIMIT erreicht ({(start - acc.equity) / start * 100:.2f} %) – keine neuen Trades bis morgen.")
                self.event("LIMIT", "Tagesverlust-Limit", f"{(start - acc.equity) / start * 100:.2f} % Verlust seit Tagesbeginn (Grenze {self.cfg.DAILY_LOSS_LIMIT_PCT} %) – keine neuen Trades bis zum nächsten UTC-Tag")
                self.halted_day = day
            return False
        return True

    def reconnect(self) -> None:
        """Terminal weg oder getrennt: neu verbinden (mit Pause zwischen den Versuchen) – der Bot läuft einfach weiter."""
        if time.monotonic() - getattr(self, "_last_reconnect", -1e9) < 20:
            return
        self._last_reconnect = time.monotonic()
        log.warning("Keine Verbindung zum MetaTrader-Konto – versuche neu zu verbinden …")
        try:
            self.mt5.shutdown()
        except Exception:
            pass
        kw = {}
        if getattr(self.cfg, "MT5_LOGIN", None):
            kw = dict(login=self.cfg.MT5_LOGIN, password=self.cfg.MT5_PASSWORD, server=self.cfg.MT5_SERVER)
        if getattr(self.cfg, "MT5_TERMINAL_PATH", None):
            kw["path"] = self.cfg.MT5_TERMINAL_PATH
        if self.mt5.initialize(**kw) and self.mt5.account_info() is not None:
            log.info("Wieder verbunden.")
            self.event("FEHLER", "Verbindung", "MetaTrader-Verbindung war weg und wurde wiederhergestellt")
        else:
            raise RuntimeError(f"MetaTrader nicht erreichbar: {self.mt5.last_error()}")

    def kill_requested(self) -> bool:
        return self._path(self.cfg.KILL_FILE).exists()

    # ---------- offene Positionen: R-Vielfaches, Breakeven, Zeit-Stopp ----------
    def profile_of(self, pos) -> dict | None:
        return next((p for p in self.profiles if p["magic"] == pos.magic), None)

    def _market_of(self, prof: dict, pos) -> str | None:
        return next((n for n in prof["markets"] if self.symbols.get(n) == pos.symbol), None)

    def _price(self, pos) -> float:
        cur = getattr(pos, "price_current", 0) or 0
        if cur:
            return float(cur)
        tick = self.mt5.symbol_info_tick(pos.symbol)
        buy = pos.type == self.mt5.POSITION_TYPE_BUY
        return float((tick.bid if buy else tick.ask) if tick else pos.price_open)

    def track_positions(self, now: datetime | None = None) -> None:
        """Merkt sich je Position Einstieg, Anfangs-Stop (= 1R), Zeit, besten Kurs; schließt beendete Positionen ab (Auswertung)."""
        now = now or datetime.now(timezone.utc)
        rec = self.state.setdefault("trades", {})
        live = {str(p.ticket): p for p in self.all_positions()}
        for t in [t for t in rec if t not in live]:
            self._finish_trade(t, rec[t])
            del rec[t]
        for t, pos in live.items():
            price = self._price(pos)
            r = rec.get(t)
            if r is None or "entry" not in r:
                opened = getattr(pos, "time", 0)
                keep = r or {}
                rec[t] = r = {**keep, "entry": float(pos.price_open), "sl0": float(pos.sl), "best": price,
                              "opened": datetime.fromtimestamp(opened, timezone.utc).isoformat() if opened else now.isoformat()}
            if not r.get("sl0") and pos.sl:
                r["sl0"] = float(pos.sl)
            buy = pos.type == self.mt5.POSITION_TYPE_BUY
            r["best"] = max(r["best"], price) if buy else min(r["best"], price)
            label, _ = self.bot_name(pos.magic)
            r.update(symbol=pos.symbol, magic=pos.magic, profile=label, direction="long" if buy else "short", volume=pos.volume,
                     last_profit=float(getattr(pos, "profit", 0.0)), last_price=price)
        self._save_state()

    def _finish_trade(self, ticket: str, r: dict) -> None:
        """Position ist weg (vom Bot, per Stop-Loss/Take-Profit beim Broker oder von Hand geschlossen): Grund und Ergebnis festhalten."""
        mt5 = self.mt5
        reason, profit, price = r.get("close_reason"), None, r.get("close_price")
        try:
            if hasattr(mt5, "history_select"):
                now = datetime.now(timezone.utc)
                mt5.history_select(now - timedelta(days=30), now + timedelta(days=1))
            deals = mt5.history_deals_get(position=int(ticket)) if hasattr(mt5, "history_deals_get") else None
            outs = [d for d in (deals or []) if getattr(d, "entry", 0) == 1]
            if outs:
                profit = sum(d.profit + getattr(d, "commission", 0) + getattr(d, "swap", 0) for d in outs)
                price = outs[-1].price
                if not reason:
                    why = {getattr(mt5, "DEAL_REASON_SL", 3): "Stop-Loss getroffen", getattr(mt5, "DEAL_REASON_TP", 4): "Take-Profit erreicht"}
                    reason = why.get(getattr(outs[-1], "reason", -1))
        except Exception:
            log.exception("Abschlussdaten nicht abrufbar")
        reason = reason or "geschlossen (Stop-Loss, Take-Profit oder manuell)"
        if profit is None:
            profit = r.get("last_profit")      # Näherung: letzter bekannter Gewinn
        if price is None:
            price = r.get("last_price")
        entry, sl0 = r.get("entry"), r.get("sl0")
        sign = 1 if r.get("direction", "long") == "long" else -1
        r_mult = sign * (price - entry) / abs(entry - sl0) if price is not None and entry is not None and sl0 and abs(entry - sl0) > 0 else None
        opened = r.get("opened")
        days = (datetime.now(timezone.utc) - datetime.fromisoformat(opened)).total_seconds() / 86400 if opened else None
        sym = r.get("symbol", "")
        text = f"{reason}" + (f" @ {price}" if price is not None else "") + (f", Ergebnis {profit:+.2f}" if profit is not None else "") + (f" ({r_mult:+.2f}R)" if r_mult is not None else "")
        self.event("VERKAUF", f"{sym} #{ticket} [{r.get('profile', '?')}]", text + (f" | ursprüngliche Begründung: {r['reason'].splitlines()[0]}" if r.get("reason") else ""))
        now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
        history.append_trade(self.folder, {"opened": opened, "closed": now_iso, "profile": r.get("profile", ""), "symbol": sym, "direction": r.get("direction", ""),
                                           "lots": r.get("volume", ""), "entry": entry, "exit": price, "sl0": sl0, "pnl": None if profit is None else round(profit, 2),
                                           "r": None if r_mult is None else round(r_mult, 3), "days": None if days is None else round(days, 3),
                                           "close_reason": reason, "open_reason": (r.get("reason") or "").replace("\n", " | ")})
        self.journal({"zeit": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "ereignis": "CLOSE", "profil": r.get("profile", ""), "symbol": sym, "richtung": r.get("direction", ""),
                      "lots": r.get("volume", ""), "preis": price, "gewinn": "" if profit is None else f"{profit:.2f}", "grund": reason})

    def r_values(self, pos) -> tuple[float | None, float | None]:
        r = self.state.get("trades", {}).get(str(pos.ticket))
        if not r or not r.get("sl0"):
            return None, None
        risk = abs(r["entry"] - r["sl0"])
        if risk <= 0:
            return None, None
        sign = 1 if pos.type == self.mt5.POSITION_TYPE_BUY else -1
        return sign * (self._price(pos) - r["entry"]) / risk, sign * (r["best"] - r["entry"]) / risk

    def manage_open(self, now: datetime | None = None) -> None:
        """Optional je Profil: Stop auf Einstand ziehen ab breakeven_at_r, Position nach max_days Tagen schließen."""
        now = now or datetime.now(timezone.utc)
        mt5 = self.mt5
        for pos in self.positions():
            prof = self.profile_of(pos)
            rec = self.state.get("trades", {}).get(str(pos.ticket))
            if not prof or not rec:
                continue
            if prof.get("max_days") and (now - datetime.fromisoformat(rec["opened"])).total_seconds() / 86400 >= prof["max_days"]:
                self.close(pos, f"Zeit-Stopp nach {prof['max_days']} Tagen")
                continue
            be = prof.get("breakeven_at_r")
            _, max_r = self.r_values(pos)
            buy = pos.type == mt5.POSITION_TYPE_BUY
            at_be = pos.sl >= rec["entry"] if buy else (0 < pos.sl <= rec["entry"])
            if be and max_r is not None and max_r >= be and not at_be:
                res = mt5.order_send({"action": mt5.TRADE_ACTION_SLTP, "symbol": pos.symbol, "position": pos.ticket,
                                      "sl": rec["entry"], "tp": pos.tp, "magic": pos.magic})
                ok = bool(res and res.retcode == mt5.TRADE_RETCODE_DONE)
                log.info(f"{pos.symbol}: Stop auf Einstand {rec['entry']} {'gezogen' if ok else 'NICHT gesetzt'} (MaxR {max_r:.2f})")

    # ---------- Datenstand für die Oberfläche ----------
    def write_snapshot(self, error: str | None = None) -> None:
        mt5, now = self.mt5, datetime.now(timezone.utc)
        self.track_positions(now)  # auch eben erst eröffnete Positionen erfassen
        acc = mt5.account_info()
        positions = []
        for pos in self.all_positions():
            prof = self.profile_of(pos) or next((p for p in self.cfg.PROFILES if p["magic"] == pos.magic), {})
            label, own = self.bot_name(pos.magic)
            tf = next((t for n, t in prof.get("markets", {}).items() if n == pos.symbol or self.symbols.get(n) == pos.symbol), "H4")
            df = self.closed_bars_raw(pos.symbol, tf)
            rec = self.state.get("trades", {}).get(str(pos.ticket), {})
            r_now, r_max = self.r_values(pos)
            price = self._price(pos)
            high52 = None
            try:
                d1 = mt5.copy_rates_from_pos(pos.symbol, self.tf["D1"], 0, 260)
                if d1 is not None and len(d1):
                    high52 = float(max(x["high"] for x in d1))
            except Exception:  # nicht jeder Broker liefert genug Tageskerzen
                high52 = None
            tail = df.iloc[-120:] if df is not None else None
            opened = rec.get("opened")
            positions.append({
                "ticket": pos.ticket, "symbol": pos.symbol, "profile": label, "own": own, "magic": pos.magic, "tf": tf,
                "direction": "long" if pos.type == mt5.POSITION_TYPE_BUY else "short", "volume": pos.volume,
                "entry": rec.get("entry", pos.price_open), "sl0": rec.get("sl0"), "sl": pos.sl, "tp": pos.tp, "price": price,
                "profit": float(getattr(pos, "profit", 0.0)), "r": r_now, "max_r": r_max,
                "days": (now - datetime.fromisoformat(opened)).total_seconds() / 86400 if opened else None,
                "max_days": prof.get("max_days"), "breakeven": bool(rec and pos.sl and abs(pos.sl - rec.get("entry", -1)) < 1e-9),
                "high52w": high52,
                "candles": None if tail is None else {"t": [int(x.timestamp()) for x in tail.index], "o": tail.open.round(6).tolist(),
                                                      "h": tail.high.round(6).tolist(), "l": tail.low.round(6).tolist(), "c": tail.close.round(6).tolist()},
            })
        if time.monotonic() - getattr(self, "_status_at", -1e9) > 300 or not hasattr(self, "_status"):
            self._status = []
            for prof in self.profiles:
                for name, tf in prof["markets"].items():
                    try:
                        df = self.closed_bars(name, tf)
                        extra = {r: self.closed_bars(r, tf) for r in prof["strat"].needs}
                        text = "keine Daten" if df is None else prof["strat"].status(df, extra)
                    except Exception as e:  # Anzeige darf den Bot nie stoppen
                        text = f"Fehler: {e}"
                    self._status.append({"profile": prof["name"], "symbol": name, "tf": tf, "status": text})
            self._status_at = time.monotonic()
        snap = {
            "generated": now.isoformat(), "error": error, "poll_seconds": self.cfg.POLL_SECONDS,
            "account": None if acc is None else {"login": acc.login, "server": acc.server, "equity": acc.equity, "balance": acc.balance,
                                                  "currency": acc.currency, "demo": acc.trade_mode == mt5.ACCOUNT_TRADE_MODE_DEMO},
            "start_equity": self.state.get("start_equity"), "halted": self.halted_day is not None, "kill": self.kill_requested(),
            "paused": bool(self.state.get("paused")), "telegram": self.tg is not None,
            "symbols": sorted(self.symbols), "manual": self.manual_profile() is not None and {"risk": self.manual_profile()["risk_percent"]},
            "max_positions": self.cfg.MAX_OPEN_POSITIONS, "profiles": [{"name": p["name"], "strategy": p["strat"].name} for p in self.profiles],
            "next_bar": self._next_bar_time(), "positions": positions, "markets": self._status,
        }
        tmp = self._path(self.cfg.SNAPSHOT_FILE).with_suffix(".tmp")
        tmp.write_text(json.dumps(snap, default=str), encoding="utf-8")
        os.replace(tmp, self._path(self.cfg.SNAPSHOT_FILE))

    TF_SECONDS = {"M1": 60, "M5": 300, "M15": 900, "M30": 1800, "H1": 3600, "H4": 14400, "D1": 86400, "W1": 604800}

    def _next_bar_time(self) -> str | None:
        """Wann die nächste Kerze schließt (frühester Zeitpunkt über alle Profile/Märkte) = nächste Entscheidung."""
        times = []
        for (pname, name), t in self.last_bar.items():
            prof = next((p for p in self.profiles if p["name"] == pname), None)
            if prof is not None and hasattr(t, "timestamp"):
                times.append(t.timestamp() + 2 * self.TF_SECONDS[prof["markets"][name]])
        return datetime.fromtimestamp(min(times), timezone.utc).isoformat() if times else None

    # ---------- ein Durchlauf ----------
    def algo_watch(self) -> None:
        """Meldet (alle 6 Stunden, nicht öfter), wenn der Algo-Handel im Terminal ausgeschaltet ist – dann würde jede Order abgelehnt."""
        if time.monotonic() - getattr(self, "_algo_checked", -1e9) < 60:
            return
        self._algo_checked = time.monotonic()
        try:
            allowed = bool(getattr(self.mt5.terminal_info(), "trade_allowed", True))
        except Exception:
            return
        if allowed:
            if getattr(self, "_algo_off_since", None) is not None:
                self._algo_off_since = None
                self.event("FEHLER", "Algo-Handel", "Algo-Handel ist wieder AN")
            return
        if getattr(self, "_algo_off_since", None) is None or time.monotonic() - self._algo_off_since > 6 * 3600:
            self._algo_off_since = time.monotonic()
            log.warning("ALGO-HANDEL IM TERMINAL IST AUS – Orders werden abgelehnt. Oben in MetaTrader auf 'Algo-Handel' klicken (grün).")
            self.event("FEHLER", "Algo-Handel AUS", RETCODE_TEXT[10027])

    def step(self) -> None:
        if self.kill_requested():
            for pos in self.positions():
                self.close(pos, "Kill-Switch")
            log.warning("KILL-SWITCH aktiv: keine neuen Trades. Datei löschen, um weiterzumachen.")
            if not getattr(self, "_kill_logged", False):
                self.event("LIMIT", "Kill-Switch", "Datei KILL_SWITCH gefunden: alle eigenen Positionen geschlossen, keine neuen Trades")
                self._kill_logged = True
            return
        self._kill_logged = False
        if self.mt5.account_info() is None:
            self.reconnect()
        self.algo_watch()
        allowed = self.day_check() and not self.state.get("paused")
        self.track_positions()
        self.manage_open()
        for prof in self.profiles:
            strat = prof["strat"]
            for name, tf in prof["markets"].items():
                df = self.closed_bars(name, tf)
                if df is None or df.empty:
                    continue
                key = (prof["name"], name)
                newest = df.index[-1]
                if self.last_bar.get(key) == newest:
                    continue
                first = key not in self.last_bar
                self.last_bar[key] = newest
                if first:
                    continue  # beim Start keine Alt-Signale nachhandeln
                extra = {r: self.closed_bars(r, tf) for r in strat.needs}
                head = f"{prof['name']} | {name} {tf} | Kerze {newest:%Y-%m-%d %H:%M}"
                checks = strat.explain(df, extra)
                mine = self.positions(prof["magic"], name)
                for pos in mine:  # Ausstiegssignal der Strategie
                    direction = "long" if pos.type == self.mt5.POSITION_TYPE_BUY else "short"
                    if strat.exit(df, direction, extra):
                        self.close(pos, f"Ausstiegssignal {strat.name}")
                if self.positions(prof["magic"], name):
                    self.event("KEIN KAUF", head, "Position bereits offen – höchstens eine je Markt und Profil", checks)
                    continue
                direction = strat.entry(df, extra)
                if direction is None:
                    open_missing = [t for ok, t in checks if not ok]
                    self.event("KEIN KAUF", head, f"{len(open_missing)} Bedingung(en) nicht erfüllt" if open_missing else "keine Einstiegsregel erfüllt", checks)
                    continue
                log.info(f"SIGNAL: {direction.upper()} {name} ({tf}) {prof['name']} @ Kerze {newest}")
                if not allowed:
                    self.event("BLOCKIERT", head, f"Signal {direction.upper()}, aber Tagesverlust-Limit erreicht – kein Trade", checks)
                    continue
                if len(self.positions()) >= self.cfg.MAX_OPEN_POSITIONS:
                    log.info(f"{name}: Max. offene Positionen ({self.cfg.MAX_OPEN_POSITIONS}) erreicht – übersprungen.")
                    self.event("BLOCKIERT", head, f"Signal {direction.upper()}, aber Positionslimit ({self.cfg.MAX_OPEN_POSITIONS}) erreicht", checks)
                    continue
                why = f"{strat.name}: " + "; ".join(t for _, t in checks)
                self.last_order_error = None
                if self.place(prof, name, direction, why):
                    self.event("KAUF", head, f"{direction.upper()} eröffnet", checks)
                else:
                    self.event("FEHLER", head, f"Signal {direction.upper()}, aber Order nicht ausgeführt: {self.last_order_error or 'Lot-Größe nicht berechenbar, Spread oder Ablehnung (Details im Log)'}", checks)

    def diagnose_text(self) -> str:
        """„Warum kein Trade?“: prüft Verbindung, Algo-Handel, Symbole, Kerzen und zeigt, wie oft die Strategie früher ein Signal gegeben hätte."""
        mt5, L = self.mt5, []
        ok = lambda b: "✔" if b else "✘"  # noqa: E731
        acc = mt5.account_info()
        L.append("1. VERBINDUNG UND ERLAUBNISSE")
        L.append(f"   {ok(acc is not None)} Konto: " + (f"{acc.login} ({acc.server}), {'DEMO' if acc.trade_mode == mt5.ACCOUNT_TRADE_MODE_DEMO else 'ECHTGELD'}, Kapital {acc.equity:.2f} {acc.currency}" if acc else "KEINE VERBINDUNG"))
        try:
            ti = mt5.terminal_info()
            L.append(f"   {ok(getattr(ti, 'connected', True))} Terminal mit dem Broker verbunden")
            L.append(f"   {ok(getattr(ti, 'trade_allowed', True))} 'Algo-Handel' im Terminal AN" + ("" if getattr(ti, "trade_allowed", True) else "  ← oben in MetaTrader auf den Knopf 'Algo-Handel' klicken (grün)"))
        except Exception:
            L.append("   (Terminal-Status nicht abrufbar)")
        if acc is not None:
            L.append(f"   {ok(getattr(acc, 'trade_allowed', True))} Konto darf handeln   {ok(getattr(acc, 'trade_expert', True))} Konto erlaubt Experten/Algo-Handel")
        L.append(f"   {ok(not self.state.get('paused'))} nicht pausiert   {ok(not self.kill_requested())} kein Kill-Switch   {ok(self.halted_day is None)} Tageslimit nicht erreicht   "
                 f"Positionen {len(self.positions())}/{self.cfg.MAX_OPEN_POSITIONS}")
        L.append("")
        L.append("2. MÄRKTE UND SIGNALE (Rückblick: wie oft hätte die Strategie ein Signal gegeben?)")
        now = datetime.now(timezone.utc)
        total_year = 0.0
        for prof in self.profiles:
            strat = prof["strat"]
            L.append(f"   Profil '{prof['name']}': {strat.name}")
            for name, tf in prof["markets"].items():
                sym = self.symbols.get(name)
                head = f"   - {name} ({tf})"
                if sym is None:
                    L.append(f"{head}: ✘ Symbol beim Broker NICHT gefunden → wird nie gehandelt (Namen in SYMBOL_ALIASES eintragen)")
                    continue
                df = self.closed_bars(name, tf)
                if df is None or df.empty:
                    L.append(f"{head}: ✘ {sym}: keine Kerzen (Markt geschlossen oder Symbol nicht im Marktfenster)")
                    continue
                tick = mt5.symbol_info_tick(sym)
                tick_age = (now.timestamp() - tick.time) / 3600 if tick is not None and getattr(tick, "time", 0) else None
                last = df.index[-1]
                age_h = (now - last.to_pydatetime()).total_seconds() / 3600
                step_h = (df.index[-1] - df.index[-2]).total_seconds() / 3600 if len(df) > 1 else 0
                extra = {r: self.closed_bars(r, tf) for r in strat.needs}
                bars_per_year = 365 * 24 / step_h if step_h else 0
                try:
                    hits = replay_signals(strat, df, extra, int(bars_per_year * 1.2) or len(df))
                except Exception as e:  # Rückblick darf die Diagnose nie stoppen
                    hits, L2 = [], f"Rückblick nicht möglich ({e})"
                else:
                    L2 = None
                n_hist = len(df)
                span_days = (df.index[-1] - df.index[0]).days or 1
                per_year = len(hits) / min(span_days, 365 * 1.2) * 365 if hits is not None else 0
                total_year += per_year
                recent = [h for h in hits if (now - h.to_pydatetime()).days <= 30]
                lines = f"{head}: {ok(True)} {sym}, {n_hist} Kerzen, letzte geschlossene {last:%Y-%m-%d %H:%M} UTC (vor {age_h:.1f} h)"
                if tick_age is not None and tick_age > 3:
                    lines += f"; ⚠ letzter Kurs vor {tick_age:.1f} h (Markt gerade zu?)"
                L.append(lines)
                L.append(("      " + L2) if L2 else f"      Rückblick: {len(hits)} Signal(e) in der verfügbaren Historie → ca. {per_year:.1f} pro Jahr, davon {len(recent)} in den letzten 30 Tagen"
                         + (f"; zuletzt {hits[-1]:%Y-%m-%d %H:%M}" if hits else ""))
                try:
                    checks = strat.explain(df, extra)
                    miss = [t for okk, t in checks if not okk]
                    L.append(f"      Jetzt: {'SIGNAL' if strat.entry(df, extra) else 'kein Signal'}" + (f", es fehlt: {miss[0]}" + (f" (+{len(miss) - 1} weitere)" if len(miss) > 1 else "") if miss else ""))
                except Exception:
                    pass
        L.append("")
        L.append(f"3. ERWARTUNG: Über alle Märkte dieser Profile ca. {total_year:.0f} Signale pro Jahr ≈ {total_year / 12:.1f} pro Monat ≈ {total_year / 52:.1f} pro Woche "
                 f"(begrenzt durch Positionslimit und Tageslimit).")
        if total_year < 12:
            L.append("   → Das ist wenig: Mehrere Tage ohne Trade sind NORMAL. Mehr Märkte oder weitere Strategien (siehe survey.profil_erzeugen) erhöhen die Zahl.")
        L.append("   Bot-Funktion testen, ohne auf ein Signal zu warten: Telegram 🟢 Kaufen oder Portal → Kaufen (Demo-Konto, mit Stop und Ziel).")
        return "\n".join(L)

    def heartbeat(self) -> None:
        acc = self.mt5.account_info()
        log.info(f"♥ {datetime.now().strftime('%H:%M')} – läuft, {len(self.profiles)} Profil(e), {len(self.positions())} Position(en) offen"
                 + (f", Kapital {acc.equity:.2f} {acc.currency}" if acc else ""))
        for prof in self.profiles:
            for name, tf in prof["markets"].items():
                df = self.closed_bars(name, tf)
                if df is None:
                    log.info(f"   [{prof['name']}] {name} ({tf}): keine Daten (Markt geschlossen?)")
                    continue
                extra = {r: self.closed_bars(r, tf) for r in prof["strat"].needs}
                log.info(f"   [{prof['name']}] {name} ({tf}): {prof['strat'].status(df, extra)}")

    def start_telegram(self) -> None:
        from . import telegram as tgm
        if not getattr(self.cfg, "TELEGRAM_ENABLED", True):
            return
        token, chat = tgm.load_credentials(self.folder)
        if not token or not chat:
            log.info("Telegram: nicht eingerichtet (python -m mt5bot.telegram_setup) – läuft ohne.")
            return
        self.tg = tgm.TelegramBridge(self, tgm.TelegramApi(token), chat)
        self.tg.start()
        acc = self.mt5.account_info()
        self.tg.notify(f"MT5-Bot gestartet ({'DEMO' if acc and acc.trade_mode == self.mt5.ACCOUNT_TRADE_MODE_DEMO else 'KONTO'} {acc.login if acc else '?'}). "
                       f"Profile: {', '.join(p['name'] for p in self.profiles)}. /help zeigt die Befehle.")
        log.info("Telegram: verbunden (Befehle: /help)")

    def log_equity(self, force: bool = False) -> None:
        if not force and time.monotonic() - self.last_equity_log < 300:
            return
        acc = self.mt5.account_info()
        if acc is not None:
            history.append_equity(self.folder, datetime.now(timezone.utc), acc.equity)
            self.last_equity_log = time.monotonic()

    def periodic_summary(self) -> None:
        hours = getattr(self.cfg, "TELEGRAM_REPORT_HOURS", 0)
        if not hours or self.tg is None:
            return
        last = self.state.get("last_tg_summary")
        if last and (datetime.now(timezone.utc) - datetime.fromisoformat(last)).total_seconds() < hours * 3600:
            return
        self.state["last_tg_summary"] = datetime.now(timezone.utc).isoformat()
        self._save_state()
        self.tg.c_status([])
        if self.all_positions():
            self.tg.c_trades([])

    def pump(self, seconds: float) -> None:
        """Wartet bis zum nächsten Durchlauf, bearbeitet dabei jede Sekunde Telegram-Befehle (schnelle Reaktion auf dem Handy)."""
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if self.tg is not None:
                self.tg.process()
            self.process_web_commands()
            time.sleep(min(1.0, max(0.0, end - time.monotonic())))

    def run_forever(self) -> None:
        setup_logging(str(self._path(self.cfg.LOG_FILE)))
        log.info("=" * 60)
        log.info("MT5-Bot startet: " + ", ".join(f"{p['name']} ({p['strat'].name})" for p in self.profiles))
        self.connect()
        if getattr(self.cfg, "DASHBOARD_PORT", 0):
            from .dashboard import serve
            info = serve(self.folder, self.cfg.DASHBOARD_PORT, self.cfg.SNAPSHOT_FILE, lan=getattr(self.cfg, "DASHBOARD_PHONE", False),
                         control=getattr(self.cfg, "DASHBOARD_CONTROL", "local"), submit=self.submit_web_command, results=self.web_results,
                         symbols=lambda: sorted(self.symbols),
                         open_browser=getattr(self.cfg, "DASHBOARD_OPEN_BROWSER", True) and not os.environ.get("MT5BOT_NO_BROWSER"))
            log.info(f"Oberfläche: {info['local']}")
            for u in info["phone"]:
                log.info(f"Auf dem Handy (gleiches WLAN oder Tailscale): {u}   <- Link geheim halten, er enthält den Zugangsschlüssel")
        self.start_telegram()
        self.heartbeat()
        try:
            self.maybe_report(force=True)  # Startbericht: Zustand und Marktanalyse sofort
            self.log_equity(force=True)
        except Exception:
            log.exception("Startbericht konnte nicht geschrieben werden")
        last_hb = time.monotonic()
        try:
            while True:
                error = None
                try:
                    self.step()
                except Exception as e:  # ein Fehler (z. B. kurz keine Verbindung) beendet den Bot nicht
                    error = f"{type(e).__name__}: {e}"
                    log.exception("Fehler im Durchlauf – nächster Versuch in Kürze")
                    self.errors_since_report.append(error)
                    self.event("FEHLER", "Durchlauf", error)
                try:
                    self.write_snapshot(error)
                    self.log_equity()
                except Exception:
                    log.exception("Datenstand für die Oberfläche konnte nicht geschrieben werden")
                try:
                    self.maybe_report()
                    self.periodic_summary()
                except Exception:
                    log.exception("Bericht konnte nicht geschrieben werden")
                if time.monotonic() - last_hb >= self.cfg.HEARTBEAT_MINUTES * 60:
                    self.heartbeat()
                    last_hb = time.monotonic()
                self.pump(self.cfg.POLL_SECONDS)
        except KeyboardInterrupt:
            log.info("Bot gestoppt. Offene Positionen sind durch Stop-Loss/Take-Profit beim Broker gesichert.")
            if self.tg is not None:
                try:
                    self.tg.api.call("sendMessage", {"chat_id": self.tg.chat_id, "text": "MT5-Bot gestoppt (Positionen bleiben durch Stop/Ziel beim Broker gesichert)."}, timeout=5)
                except Exception:
                    pass
        finally:
            if self.tg is not None:
                self.tg.stop()
            self.mt5.shutdown()
