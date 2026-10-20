"""Telegram einrichten:  python -m mt5bot.telegram_setup

1. In Telegram @BotFather öffnen → /newbot → Namen wählen → du bekommst einen Token (lange Zeichenfolge mit Doppelpunkt).
2. Dieses Programm starten, den Token eingeben (die Eingabe bleibt unsichtbar) und deinem neuen Bot eine Nachricht schicken.
3. Das Programm findet deine Chat-ID selbst und speichert beides in mt5bot_telegram.json (nur lokal, nicht im Repository).
Den Token niemals in Chats oder Screenshots weitergeben – wer ihn hat, kann den Bot steuern. Bei Verdacht in @BotFather /revoke.
"""
from __future__ import annotations

import getpass
import json
import os
import sys
import time
from pathlib import Path

from .telegram import CRED_FILE, TelegramApi


class WebSetup:
    """Dieselbe Einrichtung wie unten, aber in Schritten für die Oberfläche (Token prüfen → Chat finden → speichern).
    Der Token bleibt nur im Speicher dieses Objekts und wird nie an den Browser zurückgegeben."""

    def __init__(self, folder: str | Path = "."):
        self.folder, self.api, self.bot, self.chat = Path(folder), None, None, None
        self.offset = None

    def check(self, token: str) -> dict:
        token = (token or "").strip()
        if ":" not in token or len(token) > 120 or any(c.isspace() for c in token):
            raise ValueError("Das sieht nicht wie ein Token aus (Format 123456789:ABC…).")
        api = TelegramApi(token)
        try:
            me = api.call("getMe", timeout=15)["result"]
        except Exception as e:
            raise ValueError(f"Token ungültig oder keine Verbindung: {e}") from None
        self.api, self.bot, self.chat, self.token = api, me.get("username"), None, token
        try:
            api.call("getUpdates", {"offset": -1}, timeout=15)
        except Exception:
            pass
        return {"bot": self.bot}

    def find(self) -> dict | None:
        """Sucht eine frische Nachricht an den Bot (der Nutzer schickt /start). None = noch keine."""
        if self.api is None:
            raise ValueError("Zuerst den Token prüfen.")
        res = self.api.call("getUpdates", {"offset": self.offset, "timeout": 0}, timeout=15).get("result", [])
        for upd in res:
            self.offset = upd["update_id"] + 1
            m = upd.get("message")
            if m and m.get("chat", {}).get("id") and m["chat"].get("type") == "private" and time.time() - m.get("date", 0) < 300:
                self.chat = m["chat"]
        if not self.chat:
            return None
        return {"name": self.chat.get("first_name") or self.chat.get("username") or "?", "chat_id": str(self.chat["id"])}

    def save(self, chat_id: str) -> None:
        if self.api is None or not self.chat or str(self.chat["id"]) != str(chat_id):
            raise ValueError("Erst Token prüfen und dem Bot eine Nachricht schicken.")
        f = self.folder / CRED_FILE
        f.write_text(json.dumps({"token": self.token, "chat_id": str(self.chat["id"])}), encoding="utf-8")
        try:
            os.chmod(f, 0o600)
        except OSError:
            pass
        self.api.call("sendMessage", {"chat_id": self.chat["id"], "text": "MT5-Bot: Telegram ist eingerichtet. /help zeigt die Befehle."})


def main(folder: str = ".") -> int:
    token = getpass.getpass("Bot-Token (Eingabe unsichtbar, dann Enter): ").strip()
    if ":" not in token:
        print("Das sieht nicht wie ein Token aus (Format 123456789:ABC...).")
        return 1
    api = TelegramApi(token)
    try:
        me = api.call("getMe", timeout=15)["result"]
    except Exception as e:
        print(f"Token ungültig oder keine Verbindung: {e}")
        return 1
    print(f"Bot gefunden: @{me.get('username')}. Schick ihm jetzt in Telegram eine Nachricht (z. B. /start) – ich warte bis zu 2 Minuten …")
    try:
        api.call("getUpdates", {"offset": -1}, timeout=15)
    except Exception:
        pass
    deadline, chat = time.time() + 120, None
    offset = None
    while time.time() < deadline and chat is None:
        try:
            res = api.call("getUpdates", {"offset": offset, "timeout": 10}, timeout=20).get("result", [])
        except Exception as e:
            print(f"(Abfrage fehlgeschlagen: {e})")
            time.sleep(3)
            continue
        for upd in res:
            offset = upd["update_id"] + 1
            m = upd.get("message")
            if m and m.get("chat", {}).get("id") and time.time() - m.get("date", 0) < 180:
                chat = m["chat"]
    if chat is None:
        print("Keine Nachricht erhalten. Nochmal starten und dem Bot zuerst /start schicken.")
        return 1
    name = chat.get("first_name") or chat.get("title") or chat.get("username") or "?"
    if input(f"Nachricht von {name} (Chat-ID {chat['id']}). Das bist du? Nur dieser Chat darf den Bot steuern. [j/n] ").strip().lower() not in ("j", "ja", "y", "yes"):
        print("Abgebrochen.")
        return 1
    f = Path(folder) / CRED_FILE
    f.write_text(json.dumps({"token": token, "chat_id": str(chat["id"])}), encoding="utf-8")
    try:
        os.chmod(f, 0o600)
    except OSError:
        pass
    api.call("sendMessage", {"chat_id": chat["id"], "text": "MT5-Bot: Telegram ist eingerichtet. Starte den Bot, dann zeigt /help alle Befehle."})
    print(f"Gespeichert in {f}. Fertig – jetzt den Bot (neu) starten.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
