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
