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
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from . import config as default_config
from .signals import atr_last, make_strategy

TF_NAMES = ("M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1")
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
        magics = [p["magic"] for p in self.profiles]
        if len(set(magics)) != len(magics):
            raise ValueError("Jedes Profil braucht eine eigene Magic Number")

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
        for name in sorted(wanted):
            for cand in [name] + [a for a in self.cfg.SYMBOL_ALIASES.get(name, []) if a != name]:
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
        if sym is None:
            return None
        rates = self.mt5.copy_rates_from_pos(sym, self.tf[tf], 0, self.cfg.BARS_HISTORY)
        if rates is None or len(rates) < 10:
            return None
        df = pd.DataFrame(rates)
        df["time"] = pd.to_datetime(df["time"], unit="s", utc=True)
        df = df.set_index("time")
        df["volume"] = df["tick_volume"] if "tick_volume" in df else 1.0
        return df[["open", "high", "low", "close", "volume"]].iloc[:-1]  # letzte Zeile = laufende Kerze

    def positions(self, magic: int | None = None, name: str | None = None):
        pos = self.mt5.positions_get() or []
        magics = {p["magic"] for p in self.profiles}
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

    def place(self, prof: dict, name: str, direction: str, why: str) -> bool:
        mt5, sym = self.mt5, self.symbols[name]
        info, tick = mt5.symbol_info(sym), mt5.symbol_info_tick(sym)
        df = self.closed_bars(name, prof["markets"][name])
        if info is None or tick is None or df is None:
            return False
        a = atr_last(df)
        stop = a * prof.get("atr_stop_mult", 2.0)
        if not stop > 0:
            log.warning(f"{sym}: ATR unbrauchbar – kein Einstieg.")
            return False
        stop = max(stop, (info.trade_stops_level or 0) * info.point * 1.1)  # Broker-Mindestabstand
        long = direction == "long"
        price = tick.ask if long else tick.bid
        sl = round(price - stop if long else price + stop, info.digits)
        tp = round(price + stop * prof.get("rr", 2.0) if long else price - stop * prof.get("rr", 2.0), info.digits)
        calc = self.calc_lots(sym, direction, price, sl, prof.get("risk_percent", 1.0))
        if calc is None:
            return False
        lots, risk = calc
        req = {"action": mt5.TRADE_ACTION_DEAL, "symbol": sym, "volume": lots, "type": mt5.ORDER_TYPE_BUY if long else mt5.ORDER_TYPE_SELL,
               "price": price, "sl": sl, "tp": tp, "deviation": 20, "magic": prof["magic"], "comment": prof["name"][:20],
               "type_time": mt5.ORDER_TIME_GTC, "type_filling": mt5.ORDER_FILLING_IOC}
        res = self._send(req)
        if not res or res.retcode != mt5.TRADE_RETCODE_DONE:
            log.error(f"{sym}: Order abgelehnt (Retcode {res.retcode if res else '?'}) – es wird KEIN ungeschützter Ersatz-Trade platziert.")
            return False
        acc = mt5.account_info()
        log.info(f"ORDER AUSGEFÜHRT: {direction.upper()} {sym} {lots} Lots @ {res.price} | SL {sl} | TP {tp} | Risiko {risk:.2f} | {prof['name']}")
        self.journal({"zeit": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "ereignis": "OPEN", "profil": prof["name"], "symbol": sym,
                      "richtung": direction, "lots": lots, "preis": res.price, "sl": sl, "tp": tp, "risiko": f"{risk:.2f}",
                      "grund": why, "equity": f"{acc.equity:.2f}" if acc else ""})
        self.enforce_protection(prof, sym, sl, tp)
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
            self.journal({"zeit": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "ereignis": "CLOSE", "symbol": pos.symbol, "grund": why,
                          "gewinn": f"{pos.profit:.2f}", "lots": pos.volume})
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
                self.halted_day = day
            return False
        return True

    def kill_requested(self) -> bool:
        return self._path(self.cfg.KILL_FILE).exists()

    # ---------- ein Durchlauf ----------
    def step(self) -> None:
        if self.kill_requested():
            for pos in self.positions():
                self.close(pos, "Kill-Switch")
            log.warning("KILL-SWITCH aktiv: keine neuen Trades. Datei löschen, um weiterzumachen.")
            return
        allowed = self.day_check()
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
                mine = self.positions(prof["magic"], name)
                for pos in mine:  # Ausstiegssignal der Strategie
                    direction = "long" if pos.type == self.mt5.POSITION_TYPE_BUY else "short"
                    if strat.exit(df, direction, extra):
                        self.close(pos, f"Ausstiegssignal {strat.name}")
                if self.positions(prof["magic"], name) or not allowed:
                    continue
                direction = strat.entry(df, extra)
                if direction is None:
                    continue
                log.info(f"SIGNAL: {direction.upper()} {name} ({tf}) {prof['name']} @ Kerze {newest}")
                if len(self.positions()) >= self.cfg.MAX_OPEN_POSITIONS:
                    log.info(f"{name}: Max. offene Positionen ({self.cfg.MAX_OPEN_POSITIONS}) erreicht – übersprungen.")
                    continue
                self.place(prof, name, direction, f"{strat.name}: {strat.status(df, extra)}")

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

    def run_forever(self) -> None:
        setup_logging(str(self._path(self.cfg.LOG_FILE)))
        log.info("=" * 60)
        log.info("MT5-Bot startet: " + ", ".join(f"{p['name']} ({p['strat'].name})" for p in self.profiles))
        self.connect()
        self.heartbeat()
        last_hb = time.monotonic()
        try:
            while True:
                self.step()
                if time.monotonic() - last_hb >= self.cfg.HEARTBEAT_MINUTES * 60:
                    self.heartbeat()
                    last_hb = time.monotonic()
                time.sleep(self.cfg.POLL_SECONDS)
        except KeyboardInterrupt:
            log.info("Bot gestoppt. Offene Positionen sind durch Stop-Loss/Take-Profit beim Broker gesichert.")
        finally:
            self.mt5.shutdown()
