"""Einstiegspunkt für die fertige MT5Bot.exe (PyInstaller)."""
import sys

from mt5bot.app import main

if __name__ == "__main__":
    sys.exit(main())
