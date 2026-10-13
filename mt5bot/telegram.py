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
import secrets
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

# Feste Tasten unten im Chat (Telegram sendet beim Tippen den Beschriftungstext)
MAIN_KEYBOARD = {"keyboard": [[{"text": "📊 Status"}, {"text": "📋 Trades"}],
                              [{"text": "🟢 Kaufen"}, {"text": "🔴 Verkaufen"}],
                              [{"text": "📈 Märkte"}, {"text": "🧾 Statistik"}],
                              [{"text": "⏸ Pause"}, {"text": "▶ Weiter"}],
                              [{"text": "❌ Alle schließen"}, {"text": "🛑 Not-Aus"}],
                              [{"text": "📄 Bericht"}, {"text": "🔔 Log"}]],
                 "resize_keyboard": True, "is_persistent": True}
BUTTON_COMMANDS = {"📊 Status": "/status", "📋 Trades": "/trades", "🟢 Kaufen": "/kaufen", "🔴 Verkaufen": "/verkaufen", "📈 Märkte": "/markets",
                   "🧾 Statistik": "/stats", "⏸ Pause": "/pause", "▶ Weiter": "/resume", "❌ Alle schließen": "/closeall", "🛑 Not-Aus": "/kill",
                   "📄 Bericht": "/report", "🔔 Log": "/log", "☰ Menü": "/menu"}
RISKS = (0.25, 0.5, 1.0, 2.0)


def inline(rows: list[list[tuple[str, str]]]) -> dict:
    return {"inline_keyboard": [[{"text": t, "callback_data": d} for t, d in row] for row in rows]}


HELP = """MT5-Bot – Bedienung
Unten im Chat stehen Tasten (Status, Trades, Kaufen, Verkaufen, Pause, Not-Aus …). /menu zeigt sie erneut.
Alles, was Geld bewegt, fragt vorher mit Knöpfen „Ja / Abbrechen" nach (60 s gültig).

Befehle (gehen auch per Text)
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
/ja – bestätigen, /nein – abbrechen
/menu – Tasten anzeigen"""


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
                res = self.api.call("getUpdates", {"offset": self.offset, "timeout": 25, "allowed_updates": ["message", "callback_query"]}, timeout=35)
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
                text, markup = self.outbox.get(timeout=1)
            except queue.Empty:
                continue
            for attempt in range(3):
                try:
                    self._send_now(text, markup)
                    break
                except Exception as e:
                    log.warning(f"Telegram-Senden fehlgeschlagen ({e})")
                    self._stop.wait(2 * (attempt + 1))

    def _send_now(self, text: str, markup: dict | None) -> None:
        params = {"chat_id": self.chat_id, "text": text, "disable_web_page_preview": True}
        if markup:
            params["reply_markup"] = markup
        self.api.call("sendMessage", params, timeout=20)

    def notify(self, text: str, markup: dict | None = None) -> None:
        parts = chunks(text)
        for i, part in enumerate(parts):
            m = markup if i == len(parts) - 1 else None  # Tasten hängen an der letzten Teil-Nachricht
            if self.sync:
                self._send_now(part, m)
            else:
                self.outbox.put((part, m))

    # ---------- eingehende Nachrichten und Knopfdrücke ----------
    def ingest(self, upd: dict) -> None:
        """Wird vom Abfrage-Thread aufgerufen: prüft Absender und Alter, legt Befehle in die Warteschlange der Hauptschleife."""
        cb = upd.get("callback_query")
        if cb:
            chat = str(((cb.get("message") or {}).get("chat") or {}).get("id", ""))
            self._answer_cb(cb.get("id"))
            if chat != self.chat_id:
                return  # Knopfdrücke aus fremden Chats werden ignoriert
            self.inbox.put(("cb", cb.get("data") or ""))
            return
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

    def _answer_cb(self, cb_id) -> None:
        if not cb_id:
            return
        try:
            self.api.call("answerCallbackQuery", {"callback_query_id": cb_id}, timeout=10)
        except Exception:
            pass

    def _reply_to(self, chat: str, text: str) -> None:
        try:
            self.api.call("sendMessage", {"chat_id": chat, "text": text})
        except Exception as e:
            log.warning(f"Telegram-Antwort fehlgeschlagen ({e})")

    def process(self) -> None:
        """Aus der Hauptschleife: wartende Befehle und Knopfdrücke ausführen."""
        while True:
            try:
                item = self.inbox.get_nowait()
            except queue.Empty:
                return
            try:
                if isinstance(item, tuple):
                    self.on_callback(item[1])
                else:
                    self.handle(item)
            except Exception as e:  # ein Befehl darf den Bot nie stoppen
                log.exception("Telegram-Befehl fehlgeschlagen")
                self.say(f"Fehler bei '{item if isinstance(item, str) else item[1]}': {type(e).__name__}: {e}")

    def say(self, text: str, markup: dict | None = None) -> None:
        self.notify(text, markup)

    # ---------- Befehle ----------
    def handle(self, text: str) -> None:
        text = BUTTON_COMMANDS.get(text, text)
        cmd, *args = text.split()
        cmd = cmd.split("@")[0].lower()
        table = {"/start": self.c_menu, "/menu": self.c_menu, "/help": self.c_help, "/status": self.c_status, "/trades": self.c_trades, "/trade": self.c_trade,
                 "/markets": self.c_markets, "/stats": self.c_stats, "/log": self.c_log, "/report": self.c_report, "/close": self.c_close,
                 "/closeall": self.c_closeall, "/buy": lambda a: self.c_open("long", a), "/sell": lambda a: self.c_open("short", a),
                 "/kaufen": lambda a: self.pick_symbol("long"), "/verkaufen": lambda a: self.pick_symbol("short"),
                 "/kill": self.c_kill, "/pause": self.c_pause, "/resume": self.c_resume, "/ja": self.c_yes, "/nein": self.c_no}
        fn = table.get(cmd)
        if fn is None:
            self.say("Unbekannter Befehl. Die Tasten unten oder /help zeigen alles.", MAIN_KEYBOARD)
            return
        fn(args)

    def on_callback(self, data: str) -> None:
        """Knopf unter einer Nachricht: Datenformat 'x:...' (max. 64 Zeichen)."""
        kind, _, rest = data.partition(":")
        if kind == "t":                                   # Trade-Details
            return self.c_trade([rest])
        if kind == "c":                                   # Trade schließen (fragt nach)
            return self.c_close([rest])
        if kind == "b":                                   # Kaufen/Verkaufen: Symbol gewählt?
            direction, _, sym = rest.partition(":")
            return self.pick_risk(direction, sym) if sym else self.pick_symbol(direction)
        if kind == "r":                                   # Risiko gewählt -> Vorschau
            direction, sym, risk = rest.split(":")
            return self.c_open(direction, [sym, risk])
        if kind in ("y", "n"):
            return self.confirm(kind == "y", rest)
        self.say("Dieser Knopf ist nicht mehr gültig.")

    def ask(self, what: str, do) -> None:
        pid = secrets.token_hex(3)
        self.pending = {"id": pid, "what": what, "do": do, "expires": time.time() + CONFIRM_SECONDS}
        self.say(f"{what}\n\nBestätigen? (gültig {CONFIRM_SECONDS} s)", inline([[("✅ Ja, ausführen", f"y:{pid}"), ("✖ Abbrechen", f"n:{pid}")]]))

    def confirm(self, yes: bool, pid: str) -> None:
        p = self.pending
        if not p or p["id"] != pid:
            self.say("Diese Bestätigung ist nicht mehr gültig (neuere Frage offen, schon erledigt oder abgelaufen).")
            return
        if not yes:
            self.pending = None
            self.say("Abgebrochen.", MAIN_KEYBOARD)
            return
        self.c_yes([])

    def c_yes(self, a) -> None:
        p, self.pending = self.pending, None
        if not p or time.time() > p["expires"]:
            self.say("Nichts zu bestätigen (oder die Frist von 60 s ist abgelaufen).", MAIN_KEYBOARD)
            return
        p["do"]()

    def c_no(self, a) -> None:
        self.say("Abgebrochen." if self.pending else "Nichts offen.", MAIN_KEYBOARD)
        self.pending = None

    def c_menu(self, a) -> None:
        self.say("MT5-Bot – Menü: benutze die Tasten unten. /help erklärt alles.", MAIN_KEYBOARD)

    def c_help(self, a) -> None:
        self.say(HELP, MAIN_KEYBOARD)

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
                 f"Profile: {', '.join(p['name'] for p in r.profiles)}", MAIN_KEYBOARD)

    def c_trades(self, a) -> None:
        poss = self.r.all_positions()
        if not poss:
            self.say("Keine offenen Trades.", MAIN_KEYBOARD)
            return
        rows = [[(f"#{p.ticket} {p.symbol} {getattr(p, 'profit', 0.0):+.0f} – Details", f"t:{p.ticket}")] for p in poss[:20]]
        self.say(f"{len(poss)} offene Trade(s):\n\n" + "\n\n".join(self.pos_line(p) for p in poss) + "\n\nTippe auf einen Trade für Details und zum Schließen:", inline(rows))

    def find(self, a):
        if not a or not a[0].lstrip("#").isdigit():
            self.say("Bitte die Trade-Nummer angeben, z. B. /close 12345 (oder in /trades auf den Trade tippen).")
            return None
        t = int(a[0].lstrip("#"))
        pos = next((p for p in self.r.all_positions() if p.ticket == t), None)
        if pos is None:
            self.say(f"Trade #{t} nicht gefunden (schon geschlossen?).")
        return pos

    def c_trade(self, a) -> None:
        pos = self.find(a)
        if pos is None:
            return
        rec = self.r.state.get("trades", {}).get(str(pos.ticket), {})
        mine = pos.magic in {p["magic"] for p in self.r.profiles} | self.r.manual_magics()
        self.say(self.pos_line(pos) + "\n\nWARUM GEKAUFT:\n" + (rec.get("reason") or "keine Begründung gespeichert (Trade stammt nicht von diesem Bot oder wurde vor dem Protokoll eröffnet)"),
                 inline([[("✖ Trade schließen", f"c:{pos.ticket}")]]) if mine else None)

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
        self.say("\n\n".join(lines) or "Keine Märkte aktiv.", MAIN_KEYBOARD)

    def c_stats(self, a) -> None:
        s = history.summary(self.r.folder)
        st, per = s["stats"], s["periods"]
        def line(name, x):
            pf = "∞" if x["profit_factor"] == float("inf") else (f"{x['profit_factor']:.2f}" if x["profit_factor"] is not None else "–")
            return (f"{name}: {x['trades']} Trades, Treffer {x['win_rate']:.0f} %, PF {pf}, Ø {x['avg_r']:+.2f}R, Summe {x['pnl']:+.2f}"
                    if x["trades"] and x["win_rate"] is not None and x["avg_r"] is not None else f"{name}: {x['trades']} Trade(s)")
        self.say(f"Heute {per['today']:+.2f} ({per['n_today']}) | Woche {per['week']:+.2f} ({per['n_week']}) | Monat {per['month']:+.2f} ({per['n_month']})\n\n"
                 + line("Alle", st["all"]) + "".join("\n" + line(k, v) for k, v in st["profiles"].items()), MAIN_KEYBOARD)

    def c_log(self, a) -> None:
        n = int(a[0]) if a and a[0].isdigit() else 12
        ev = self.r.events[-n:]
        self.say("Seit dem letzten Bericht keine Ereignisse." if not ev else "\n".join(
            f"{datetime.fromisoformat(e['t']):%H:%M} {e['kind']} {e['head']}" + (f" – {e['text']}" if e["text"] else "") for e in ev), MAIN_KEYBOARD)

    def c_report(self, a) -> None:
        text = self.r.build_report(datetime.now().astimezone())
        parts = chunks(text)
        for part in parts[:6]:
            self.say(part)
        if len(parts) > 6:
            self.say(f"(Bericht gekürzt – vollständig in logs/bericht_<Datum>.txt, {len(parts)} Teile)")

    def c_pause(self, a) -> None:
        self.say(self.r.do_pause(True, "Telegram") + " /resume oder die Taste ▶ Weiter hebt es auf.", MAIN_KEYBOARD)

    def c_resume(self, a) -> None:
        self.say(self.r.do_pause(False, "Telegram"), MAIN_KEYBOARD)

    def c_close(self, a) -> None:
        pos = self.find(a)
        if pos is None:
            return
        self.ask(f"Trade schließen?\n{self.pos_line(pos)}", lambda: self.say(self.r.do_close(pos.ticket, "Telegram: Schließen"), MAIN_KEYBOARD))

    def c_closeall(self, a) -> None:
        poss = self.r.positions()
        if not poss:
            self.say("Keine eigenen offenen Trades.", MAIN_KEYBOARD)
            return
        self.ask(f"ALLE {len(poss)} eigenen Trades schließen?\n" + "\n".join(f"#{p.ticket} {p.symbol} {getattr(p, 'profit', 0.0):+.2f}" for p in poss),
                 lambda: self.say(self.r.do_closeall("Telegram: alle schließen"), MAIN_KEYBOARD))

    def c_kill(self, a) -> None:
        n = len(self.r.positions())
        self.ask(f"NOT-AUS: {n} eigene Trade(s) schließen und neue Trades pausieren?", lambda: self.say(self.r.do_kill("Telegram: Not-Aus") + " Weiter mit ▶ Weiter.", MAIN_KEYBOARD))

    def pick_symbol(self, direction: str) -> None:
        if self.r.manual_profile() is None:
            self.say("Manuelles Eröffnen ist abgeschaltet (MANUAL['enabled'] in der Konfiguration).")
            return
        syms = sorted(self.r.symbols)
        if not syms:
            self.say("Keine Symbole verfügbar.")
            return
        rows = [[(s, f"b:{direction}:{s}") for s in syms[i:i + 3]] for i in range(0, len(syms), 3)]
        self.say(f"{'🟢 KAUFEN' if direction == 'long' else '🔴 VERKAUFEN'}: welcher Markt?", inline(rows))

    def pick_risk(self, direction: str, sym: str) -> None:
        bad = self.r.check_manual_open(sym, 0.25)
        if bad:
            self.say(bad, MAIN_KEYBOARD)
            return
        self.say(f"{'🟢 KAUFEN' if direction == 'long' else '🔴 VERKAUFEN'} {sym}: wie viel riskieren (% des Kontos bis zum Stop)?",
                 inline([[(f"{x:g} %", f"r:{direction}:{sym}:{x:g}") for x in RISKS]]))

    def c_open(self, direction: str, a) -> None:
        r = self.r
        if not a:
            self.pick_symbol(direction)
            return
        name = a[0].upper()
        try:
            risk = float(a[1].replace(",", ".")) if len(a) > 1 else (r.manual_profile() or {}).get("risk_percent", 0.5)
        except ValueError:
            self.say("Risiko bitte als Zahl in Prozent, z. B. 0.5")
            return
        bad = r.check_manual_open(name, risk)
        if bad:
            self.say(bad, MAIN_KEYBOARD)
            return
        try:
            plan = r.plan_order(r.manual_prof(name, risk), name, direction)
        except RuntimeError as e:
            self.say(f"Nicht möglich: {e}", MAIN_KEYBOARD)
            return
        self.ask(f"{direction.upper()} {name} eröffnen?\n{plan}", lambda: self.say(r.do_open(direction, name, risk, "Telegram"), MAIN_KEYBOARD))
