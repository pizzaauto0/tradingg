"""Telegram-Anbindung des MT5-Bots: Benachrichtigungen und Steuerung vom Handy.

Sicherheit:
- Der Bot antwortet NUR auf die eingetragene Chat-ID (andere bekommen nur ihre eigene ID genannt, damit du sie eintragen kannst).
- Alles, was Geld bewegt (schließen, kaufen, verkaufen, alles schließen, Not-Aus), braucht eine zweite Bestätigung mit /ja
  (60 Sekunden gültig). Alte Nachrichten aus der Zeit vor dem Start werden ignoriert.
- Token und Chat-ID stehen NICHT im Code, sondern in mt5bot_telegram.json (nicht im Repository) oder in Umgebungsvariablen.
- Befehle werden in der Hauptschleife des Bots ausgeführt (das MetaTrader-Paket ist nicht für mehrere Threads gedacht);
  nur das Netzwerk (Nachrichten holen/senden) läuft in eigenen Threads.
"""
from __future__ import annotations

import json
import logging
import os
import queue
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

from . import history

log = logging.getLogger("mt5bot")
CRED_FILE = "mt5bot_telegram.json"
MAX_LEN = 3800
CONFIRM_SECONDS = 60
MAX_AGE_SECONDS = 120

HELP = """MT5-Bot – Befehle
ANSEHEN
/status – Konto, Tages-P&L, Zustand
/trades – alle offenen Trades
/trade <Nr> – ein Trade mit Begründung
/markets – Zustand der Märkte (warum Kauf / kein Kauf)
/stats – Kennzahlen, Woche/Monat
/log – letzte Ereignisse
/report – ausführlicher Bericht jetzt
STEUERN (mit /ja bestätigen)
/close <Nr> – einen Trade schließen
/closeall – alle Trades schließen
/buy <Symbol> [Risiko%] – Kauf eröffnen
/sell <Symbol> [Risiko%] – Verkauf eröffnen
/kill – alles schließen und pausieren
/pause – keine neuen Trades (ohne Bestätigung)
/resume – wieder erlauben
/ja – bestätigen, /nein – abbrechen"""


def load_credentials(folder: str | Path = ".") -> tuple[str | None, str | None]:
    token, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    f = Path(folder) / CRED_FILE
    if (not token or not chat) and f.exists():
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
            token, chat = token or d.get("token"), chat or str(d.get("chat_id") or "")
        except (OSError, ValueError):
            log.warning("mt5bot_telegram.json nicht lesbar")
    return (token or None), (str(chat) if chat else None)


class TelegramApi:
    """Dünner Client für die Bot-API (nur urllib, keine zusätzlichen Pakete)."""

    def __init__(self, token: str):
        self.base = f"https://api.telegram.org/bot{token}/"

    def call(self, method: str, params: dict | None = None, timeout: float = 35.0) -> dict:
        req = urllib.request.Request(self.base + method, data=json.dumps(params or {}).encode(), headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:200]
            raise RuntimeError(f"Telegram HTTP {e.code}: {body}") from None  # URL (mit Token) nie in Fehlermeldungen


def chunks(text: str, size: int = MAX_LEN) -> list[str]:
    out, cur = [], ""
    for line in text.splitlines(keepends=True):
        while len(line) > size:
            out.append(line[:size]); line = line[size:]
        if len(cur) + len(line) > size:
            out.append(cur); cur = ""
        cur += line
    if cur:
        out.append(cur)
    return out or [""]


class TelegramBridge:
    def __init__(self, runner, api, chat_id: str, sync: bool = False):
        self.r, self.api, self.chat_id, self.sync = runner, api, str(chat_id), sync
        self.inbox: queue.Queue = queue.Queue()
        self.outbox: queue.Queue = queue.Queue()
        self.pending: dict | None = None
        self.offset: int | None = None
        self.started_at = time.time()
        self.warned: set = set()
        self._stop = threading.Event()

    # ---------- Netzwerk ----------
    def start(self) -> None:
        threading.Thread(target=self._poll_loop, daemon=True, name="tg-poll").start()
        threading.Thread(target=self._send_loop, daemon=True, name="tg-send").start()

    def stop(self) -> None:
        self._stop.set()

    def _poll_loop(self) -> None:
        delay = 2
        while not self._stop.is_set():
            try:
                res = self.api.call("getUpdates", {"offset": self.offset, "timeout": 25, "allowed_updates": ["message"]}, timeout=35)
                for upd in res.get("result", []):
                    self.offset = upd["update_id"] + 1
                    self.ingest(upd)
                delay = 2
            except Exception as e:  # Netzwerk weg: leise wiederholen
                log.warning(f"Telegram-Abfrage fehlgeschlagen: {e}")
                self._stop.wait(delay)
                delay = min(delay * 2, 60)

    def _send_loop(self) -> None:
        while not self._stop.is_set():
            try:
                text = self.outbox.get(timeout=1)
            except queue.Empty:
                continue
            for attempt in range(3):
                try:
                    self.api.call("sendMessage", {"chat_id": self.chat_id, "text": text, "disable_web_page_preview": True}, timeout=20)
                    break
                except Exception as e:
                    log.warning(f"Telegram-Senden fehlgeschlagen ({e})")
                    self._stop.wait(2 * (attempt + 1))

    def notify(self, text: str) -> None:
        for part in chunks(text):
            if self.sync:
                self.api.call("sendMessage", {"chat_id": self.chat_id, "text": part})
            else:
                self.outbox.put(part)

    # ---------- eingehende Nachrichten ----------
    def ingest(self, upd: dict) -> None:
        """Wird vom Abfrage-Thread aufgerufen: prüft Absender und Alter, legt Befehle in die Warteschlange der Hauptschleife."""
        msg = upd.get("message") or {}
        text = (msg.get("text") or "").strip()
        chat = str((msg.get("chat") or {}).get("id", ""))
        if not text:
            return
        if chat != self.chat_id:
            if chat and chat not in self.warned:
                self.warned.add(chat)
                self._reply_to(chat, f"Nicht berechtigt. Deine Chat-ID ist {chat}. Trage sie nur ein, wenn es dein eigener Chat ist.")
            return
        if time.time() - msg.get("date", time.time()) > MAX_AGE_SECONDS:
            return  # alte Nachricht (z. B. aus der Zeit vor einem Neustart): nie nachträglich ausführen
        self.inbox.put(text)

    def _reply_to(self, chat: str, text: str) -> None:
        try:
            self.api.call("sendMessage", {"chat_id": chat, "text": text})
        except Exception as e:
            log.warning(f"Telegram-Antwort fehlgeschlagen ({e})")

    def process(self) -> None:
        """Aus der Hauptschleife: wartende Befehle ausführen."""
        while True:
            try:
                text = self.inbox.get_nowait()
            except queue.Empty:
                return
            try:
                self.handle(text)
            except Exception as e:  # ein Befehl darf den Bot nie stoppen
                log.exception("Telegram-Befehl fehlgeschlagen")
                self.say(f"Fehler bei '{text}': {type(e).__name__}: {e}")

    def say(self, text: str) -> None:
        self.notify(text)

    # ---------- Befehle ----------
    def handle(self, text: str) -> None:
        cmd, *args = text.split()
        cmd = cmd.split("@")[0].lower()
        table = {"/start": self.c_help, "/help": self.c_help, "/status": self.c_status, "/trades": self.c_trades, "/trade": self.c_trade,
                 "/markets": self.c_markets, "/stats": self.c_stats, "/log": self.c_log, "/report": self.c_report, "/close": self.c_close,
                 "/closeall": self.c_closeall, "/buy": lambda a: self.c_open("long", a), "/sell": lambda a: self.c_open("short", a),
                 "/kill": self.c_kill, "/pause": self.c_pause, "/resume": self.c_resume, "/ja": self.c_yes, "/nein": self.c_no}
        fn = table.get(cmd)
        if fn is None:
            self.say("Unbekannter Befehl. /help zeigt alle Befehle.")
            return
        fn(args)

    def ask(self, what: str, do) -> None:
        self.pending = {"what": what, "do": do, "expires": time.time() + CONFIRM_SECONDS}
        self.say(f"{what}\nBestätigen mit /ja (gültig {CONFIRM_SECONDS} s) oder /nein.")

    def c_yes(self, a) -> None:
        p, self.pending = self.pending, None
        if not p or time.time() > p["expires"]:
            self.say("Nichts zu bestätigen (oder die Frist von 60 s ist abgelaufen).")
            return
        p["do"]()

    def c_no(self, a) -> None:
        self.say("Abgebrochen." if self.pending else "Nichts offen.")
        self.pending = None

    def c_help(self, a) -> None:
        self.say(HELP)

    def pos_line(self, pos) -> str:
        r = self.r
        label, own = r.bot_name(pos.magic)
        r_now, r_max = r.r_values(pos)
        rec = r.state.get("trades", {}).get(str(pos.ticket), {})
        days = ""
        if rec.get("opened"):
            days = f", {(datetime.now().astimezone() - datetime.fromisoformat(rec['opened'])).total_seconds() / 86400:.1f} Tage"
        return (f"#{pos.ticket} {pos.symbol} {'LONG' if pos.type == r.mt5.POSITION_TYPE_BUY else 'SHORT'} {pos.volume} Lots [{label}{'' if own else ', fremd'}]\n"
                f"   Einstieg {rec.get('entry', pos.price_open)} | Kurs {r._price(pos)} | SL {pos.sl} | TP {pos.tp}\n"
                f"   Gewinn {getattr(pos, 'profit', 0.0):+.2f}" + (f" | {r_now:+.2f}R (max {r_max:+.2f}R)" if r_now is not None else "") + days)

    def c_status(self, a) -> None:
        r, mt5 = self.r, self.r.mt5
        acc = mt5.account_info()
        if acc is None:
            self.say("Keine Verbindung zum MetaTrader-Konto.")
            return
        start = r.state.get("start_equity")
        day = f"{acc.equity - start:+.2f} ({(acc.equity - start) / start * 100:+.2f} %)" if start else "–"
        poss = r.all_positions()
        self.say(f"MT5-Bot – {'DEMO' if acc.trade_mode == mt5.ACCOUNT_TRADE_MODE_DEMO else 'ECHTGELD'}, Konto {acc.login}\n"
                 f"Kapital {acc.equity:.2f} {acc.currency} | Tag {day}\n"
                 f"Offen: {len(poss)} Position(en) | Neue Trades: {'PAUSIERT' if r.state.get('paused') else 'erlaubt'}"
                 f"{' | TAGESLIMIT' if r.halted_day else ''}{' | KILL-SWITCH' if r.kill_requested() else ''}\n"
                 f"Profile: {', '.join(p['name'] for p in r.profiles)}")

    def c_trades(self, a) -> None:
        poss = self.r.all_positions()
        self.say("Keine offenen Trades." if not poss else f"{len(poss)} offene Trade(s):\n\n" + "\n\n".join(self.pos_line(p) for p in poss))

    def find(self, a):
        if not a or not a[0].lstrip("#").isdigit():
            self.say("Bitte die Trade-Nummer angeben, z. B. /close 12345 (Nummern siehst du bei /trades).")
            return None
        t = int(a[0].lstrip("#"))
        pos = next((p for p in self.r.all_positions() if p.ticket == t), None)
        if pos is None:
            self.say(f"Trade #{t} nicht gefunden.")
        return pos

    def c_trade(self, a) -> None:
        pos = self.find(a)
        if pos is None:
            return
        rec = self.r.state.get("trades", {}).get(str(pos.ticket), {})
        self.say(self.pos_line(pos) + "\n\nWARUM GEKAUFT:\n" + (rec.get("reason") or "keine Begründung gespeichert (Trade stammt nicht von diesem Bot oder wurde vor dem Protokoll eröffnet)"))

    def c_markets(self, a) -> None:
        r, lines = self.r, []
        for prof in r.profiles:
            for name, tf in prof["markets"].items():
                df = r.closed_bars(name, tf)
                if df is None:
                    lines.append(f"[{prof['name']}] {name} {tf}: keine Daten")
                    continue
                extra = {x: r.closed_bars(x, tf) for x in prof["strat"].needs}
                checks, sig = prof["strat"].explain(df, extra), prof["strat"].entry(df, extra)
                lines.append(f"[{prof['name']}] {name} {tf}: {'SIGNAL ' + sig.upper() if sig else 'kein Signal'}\n" + r.fmt_checks(checks).replace("      ", "   "))
        self.say("\n\n".join(lines) or "Keine Märkte aktiv.")

    def c_stats(self, a) -> None:
        s = history.summary(self.r.folder)
        st, per = s["stats"], s["periods"]
        def line(name, x):
            pf = "∞" if x["profit_factor"] == float("inf") else (f"{x['profit_factor']:.2f}" if x["profit_factor"] is not None else "–")
            return (f"{name}: {x['trades']} Trades, Treffer {x['win_rate']:.0f} %, PF {pf}, Ø {x['avg_r']:+.2f}R, Summe {x['pnl']:+.2f}"
                    if x["trades"] and x["win_rate"] is not None and x["avg_r"] is not None else f"{name}: {x['trades']} Trade(s)")
        self.say(f"Heute {per['today']:+.2f} ({per['n_today']}) | Woche {per['week']:+.2f} ({per['n_week']}) | Monat {per['month']:+.2f} ({per['n_month']})\n\n"
                 + line("Alle", st["all"]) + "".join("\n" + line(k, v) for k, v in st["profiles"].items()))

    def c_log(self, a) -> None:
        n = int(a[0]) if a and a[0].isdigit() else 12
        ev = self.r.events[-n:]
        self.say("Seit dem letzten Bericht keine Ereignisse." if not ev else "\n".join(
            f"{datetime.fromisoformat(e['t']):%H:%M} {e['kind']} {e['head']}" + (f" – {e['text']}" if e["text"] else "") for e in ev))

    def c_report(self, a) -> None:
        text = self.r.build_report(datetime.now().astimezone())
        parts = chunks(text)
        for part in parts[:6]:
            self.say(part)
        if len(parts) > 6:
            self.say(f"(Bericht gekürzt – vollständig in logs/bericht_<Datum>.txt, {len(parts)} Teile)")

    def c_pause(self, a) -> None:
        self.r.state["paused"] = True
        self.r._save_state()
        self.r.event("LIMIT", "Pause", "per Telegram: keine neuen Trades (offene bleiben bestehen)")
        self.say("PAUSIERT: keine neuen automatischen Trades. Offene Positionen bleiben mit Stop/Ziel bestehen. /resume hebt es auf.")

    def c_resume(self, a) -> None:
        self.r.state["paused"] = False
        self.r._save_state()
        self.r.event("LIMIT", "Fortsetzen", "per Telegram: neue Trades wieder erlaubt")
        self.say("Neue Trades wieder erlaubt.")

    def c_close(self, a) -> None:
        pos = self.find(a)
        if pos is None:
            return
        def do():
            ok = self.r.close(pos, "Telegram /close")
            self.say(f"#{pos.ticket} {pos.symbol} geschlossen." if ok else f"#{pos.ticket}: SCHLIESSEN FEHLGESCHLAGEN – siehe Log/MetaTrader.")
        self.ask(f"Trade schließen?\n{self.pos_line(pos)}", do)

    def c_closeall(self, a) -> None:
        poss = self.r.positions()
        if not poss:
            self.say("Keine eigenen offenen Trades.")
            return
        def do():
            n = sum(self.r.close(p, "Telegram /closeall") for p in poss)
            self.say(f"{n} von {len(poss)} Trade(s) geschlossen.")
        self.ask(f"ALLE {len(poss)} eigenen Trades schließen?\n" + "\n".join(f"#{p.ticket} {p.symbol} {getattr(p, 'profit', 0.0):+.2f}" for p in poss), do)

    def c_kill(self, a) -> None:
        poss = self.r.positions()
        def do():
            self.r.state["paused"] = True
            self.r._save_state()
            n = sum(self.r.close(p, "Telegram /kill") for p in poss)
            self.r.event("LIMIT", "Not-Aus", f"per Telegram: {n} Trade(s) geschlossen, Bot pausiert")
            self.say(f"NOT-AUS: {n} von {len(poss)} Trade(s) geschlossen, neue Trades pausiert. /resume zum Fortsetzen.")
        self.ask(f"NOT-AUS: {len(poss)} eigene Trade(s) schließen und neue Trades pausieren?", do)

    def c_open(self, direction: str, a) -> None:
        r = self.r
        man = r.manual_profile()
        if man is None:
            self.say("Manuelles Eröffnen ist abgeschaltet (MANUAL['enabled'] in der Konfiguration).")
            return
        if not a:
            self.say(f"Bitte Symbol angeben, z. B. /{'buy' if direction == 'long' else 'sell'} XAUUSD 0.5 (Risiko in % optional). Verfügbar: {', '.join(sorted(r.symbols))}")
            return
        name = a[0].upper()
        if name not in r.symbols:
            self.say(f"Symbol {name} nicht verfügbar. Verfügbar: {', '.join(sorted(r.symbols))}")
            return
        try:
            risk = float(a[1].replace(",", ".")) if len(a) > 1 else man["risk_percent"]
        except ValueError:
            self.say("Risiko bitte als Zahl in Prozent, z. B. 0.5")
            return
        if not 0 < risk <= 2:
            self.say("Risiko muss größer 0 und höchstens 2 % sein.")
            return
        if not r.day_check():
            self.say("Tagesverlust-Limit erreicht – keine neuen Trades.")
            return
        if len(r.positions()) >= r.cfg.MAX_OPEN_POSITIONS:
            self.say(f"Maximal {r.cfg.MAX_OPEN_POSITIONS} Positionen gleichzeitig – erst eine schließen.")
            return
        prof = {**man, "risk_percent": risk, "markets": {name: man["timeframe"]}}
        try:
            plan = r.plan_order(prof, name, direction)
        except RuntimeError as e:
            self.say(f"Nicht möglich: {e}")
            return
        def do():
            ok = r.place(prof, name, direction, "Manuell per Telegram eröffnet (kein Strategie-Signal)")
            self.say(f"{direction.upper()} {name} eröffnet." if ok else f"{name}: Order NICHT ausgeführt – Details im Log.")
        self.ask(f"{direction.upper()} {name} eröffnen?\n{plan}", do)
