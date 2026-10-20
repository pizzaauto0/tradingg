"""Autostart unter Windows:  python -m mt5bot.autostart install | remove | status

Legt im Autostart-Ordner des Benutzers eine kleine Startdatei an, die beim Anmelden den Bot (minimiert, mit automatischem Neustart
bei Absturz) startet. Kein Administrator nötig. Voraussetzungen: Windows meldet dich nach einem Neustart automatisch an
(sonst startet nichts), der PC geht nicht in den Ruhezustand, MetaTrader ist installiert (MT5_TERMINAL_PATH in der Konfiguration
lässt den Bot das Terminal selbst starten). Für 24/7-Betrieb ohne eigenen PC: Windows-VPS.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

NAME = "MT5Bot.vbs"


def startup_dir() -> Path:
    appdata = os.environ.get("APPDATA")
    if not appdata:
        raise RuntimeError("APPDATA nicht gefunden – nur unter Windows verfügbar.")
    return Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"


def launcher_text(bat: Path) -> str:
    cmd = f'cmd /c ""{bat}""'
    return ('\' Startet den MT5-Bot beim Anmelden (minimiert). Entfernen: python -m mt5bot.autostart remove\r\n'
            'Set sh = CreateObject("WScript.Shell")\r\n'
            f'sh.Run "{cmd.replace(chr(34), chr(34) * 2)}", 7, False\r\n')


def app_command_text(cmdline: str) -> str:
    """Startdatei für die App (Fenster bleibt unsichtbar, das Portal öffnet sich erst auf Wunsch)."""
    return ('\' Startet die MT5-Bot-App beim Anmelden. Entfernen: in der App unter Einstellungen oder python -m mt5bot.autostart remove\r\n'
            'Set sh = CreateObject("WScript.Shell")\r\n'
            f'sh.Run "{cmdline.replace(chr(34), chr(34) * 2)}", 0, False\r\n')


def app_cmdline() -> str:
    """Befehlszeile der App: die fertige .exe, sonst Python aus .venv im Projektordner."""
    if getattr(sys, "frozen", False):
        return f'"{sys.executable}" --background'
    root = Path(__file__).resolve().parent.parent
    py = root / ".venv" / "Scripts" / "pythonw.exe"
    py = py if py.exists() else Path(sys.executable)
    return f'cmd /c cd /d "{root}" && "{py}" -m mt5bot.app --background'


def install(bat: Path | None = None, app: bool = False) -> Path:
    d = startup_dir()
    d.mkdir(parents=True, exist_ok=True)
    target = d / NAME
    if app:
        target.write_text(app_command_text(app_cmdline()), encoding="utf-8")
        return target
    bat = (bat or Path(__file__).with_name("run_forever.bat")).resolve()
    if not bat.exists():
        raise RuntimeError(f"{bat} fehlt")
    target.write_text(launcher_text(bat), encoding="utf-8")
    return target


def installed() -> bool:
    try:
        return (startup_dir() / NAME).exists()
    except RuntimeError:
        return False


def remove() -> bool:
    target = startup_dir() / NAME
    if target.exists():
        target.unlink()
        return True
    return False


def main(argv: list[str]) -> int:
    cmd = argv[0] if argv else "status"
    try:
        if cmd == "install":
            print(f"Autostart eingerichtet: {install()}\nDer Bot startet ab jetzt beim Anmelden. Test: abmelden und wieder anmelden (oder PC neu starten).")
        elif cmd == "remove":
            print("Autostart entfernt." if remove() else "Autostart war nicht eingerichtet.")
        else:
            t = startup_dir() / NAME
            print(f"Autostart: {'EINGERICHTET (' + str(t) + ')' if t.exists() else 'nicht eingerichtet'}")
    except RuntimeError as e:
        print(f"FEHLER: {e}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
