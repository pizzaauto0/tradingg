"""MT5-Bot als App:  python -m mt5bot.app   (oder die fertige MT5Bot.exe).

Startet den Bot mit MetaTrader 5 und öffnet das Portal in einem eigenen App-Fenster (Edge/Chrome ohne Adressleiste).
Alles Einstellbare steht im Portal (Reiter Einstellungen/Strategien) – kein Bearbeiten von config.py nötig.
Daten (Einstellungen, Protokolle, Journal, Telegram-Zugang) liegen in einem eigenen Ordner:
  Windows: %APPDATA%\\MT5Bot    sonst: ~/.mt5bot     (änderbar mit --home oder der Umgebungsvariable MT5BOT_HOME)

Optionen:
  --home ORDNER      anderer Datenordner
  --background       kein Fenster öffnen (für den Autostart)
  --no-window        wie --background
  --shortcut         Desktop-Verknüpfung „MT5 Bot“ anlegen und beenden
"""
from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

DEFAULT_PORT = 8765
TERMINAL_CANDIDATES = [
    r"C:\Program Files\MetaTrader 5\terminal64.exe",
    r"C:\Program Files (x86)\MetaTrader 5\terminal64.exe",
]
BROWSER_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
]


def home_dir(arg: str | None = None) -> Path:
    if arg:
        p = Path(arg)
    elif os.environ.get("MT5BOT_HOME"):
        p = Path(os.environ["MT5BOT_HOME"])
    elif os.name == "nt" and os.environ.get("APPDATA"):
        p = Path(os.environ["APPDATA"]) / "MT5Bot"
    else:
        p = Path.home() / ".mt5bot"
    p.mkdir(parents=True, exist_ok=True)
    return p


def message(text: str, title: str = "MT5-Bot") -> None:
    """Meldung als Fenster (Windows), sonst auf der Konsole – damit die .exe ohne Konsole Fehler sichtbar macht."""
    print(f"{title}: {text}")
    if os.name == "nt":
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, text, title, 0x40)
        except Exception:
            pass


def find_browser() -> str | None:
    for c in BROWSER_CANDIDATES:
        if Path(c).exists():
            return c
    for name in ("msedge", "chrome", "google-chrome", "chromium"):
        found = shutil.which(name)
        if found:
            return found
    return None


def open_window(url: str) -> None:
    """Eigenes App-Fenster ohne Adressleiste; ohne Edge/Chrome der normale Browser."""
    b = find_browser()
    if b:
        try:
            subprocess.Popen([b, f"--app={url}", "--window-size=1280,900"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return
        except OSError:
            pass
    import webbrowser
    webbrowser.open(url)


def port_open(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def find_terminal() -> str | None:
    for c in TERMINAL_CANDIDATES:
        if Path(c).exists():
            return c
    return None


def make_shortcut() -> Path:
    from .autostart import app_cmdline
    desktop = Path(os.environ.get("USERPROFILE", str(Path.home()))) / "Desktop"
    lnk = desktop / "MT5 Bot.lnk"
    if getattr(sys, "frozen", False):
        target, args, cwd = sys.executable, "", str(Path(sys.executable).parent)
    else:
        root = Path(__file__).resolve().parent.parent
        py = root / ".venv" / "Scripts" / "pythonw.exe"
        target, args, cwd = str(py if py.exists() else sys.executable), "-m mt5bot.app", str(root)
    ps = ("$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{lnk}');$s.TargetPath='{t}';$s.Arguments='{a}';"
          "$s.WorkingDirectory='{c}';$s.Description='MT5 Trading-Bot (Demo)';$s.Save()").format(lnk=lnk, t=target, a=args, c=cwd)
    subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=True)
    return lnk


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    for name in ("stdout", "stderr"):   # .exe ohne Konsole (--windowed): keine Ausgabe-Ströme → ins Leere schreiben statt abzustürzen
        if getattr(sys, name) is None:
            setattr(sys, name, open(os.devnull, "w", encoding="utf-8"))
    home_arg = argv[argv.index("--home") + 1] if "--home" in argv and argv.index("--home") + 1 < len(argv) else None
    background = "--background" in argv or "--no-window" in argv
    if "--shortcut" in argv:
        try:
            message(f"Verknüpfung angelegt: {make_shortcut()}")
            return 0
        except Exception as e:
            message(f"Verknüpfung nicht möglich: {e}")
            return 1
    home = home_dir(home_arg)
    from . import settings
    cfg = settings.effective(home)
    port = cfg.DASHBOARD_PORT or DEFAULT_PORT
    if port_open(port):   # läuft schon: nur das Fenster nach vorn holen
        if not background:
            open_window(f"http://127.0.0.1:{port}/")
        return 0
    try:
        import MetaTrader5 as mt5
    except ImportError:
        message("Das Python-Paket MetaTrader5 fehlt (gibt es nur für Windows, Python 3.10–3.13, 64 Bit). Mit der fertigen MT5Bot.exe ist es schon enthalten.")
        return 4
    if not cfg.MT5_TERMINAL_PATH:
        cfg.MT5_TERMINAL_PATH = find_terminal()   # startet MetaTrader selbst, falls es nicht läuft
    os.environ["MT5BOT_NO_BROWSER"] = "1"   # das Fenster öffnen wir selbst
    from .runner import Runner
    runner = Runner(mt5, cfg, home)
    runner.overlay = True
    if not background:
        def later():
            for _ in range(120):
                if port_open(port):
                    open_window(f"http://127.0.0.1:{port}/")
                    return
                time.sleep(1)
        threading.Thread(target=later, daemon=True).start()
    try:
        runner.run_forever()
    except RuntimeError as e:
        text = str(e)
        hint = ("\n\nMetaTrader 5 starten und in ein DEMO-Konto einloggen (Datei → Konto eröffnen → MetaQuotes-Demo), "
                "oben auf „Algo-Handel“ klicken (grün), dann die App erneut starten.") if "SICHERHEITSSTOPP" not in text else ""
        message(text + hint)
        return 3 if "SICHERHEITSSTOPP" in text else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
