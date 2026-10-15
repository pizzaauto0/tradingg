"""Diagnose: „Warum macht der Bot keinen Trade?“   python -m mt5bot.diagnose

Verbindet sich nur LESEND mit MetaTrader (kein Handel), prüft Verbindung/Algo-Handel/Symbole/Kerzen und zeigt je Markt, wie oft die Strategie
in der Historie ein Signal gegeben hätte. Läuft der Bot gleichzeitig, ist das kein Problem. Ergebnis zusätzlich in logs/diagnose.txt.
"""
import sys

from . import config
from .runner import Runner


def main() -> int:
    try:
        import MetaTrader5 as mt5
    except ImportError:
        print("FEHLER: Paket MetaTrader5 fehlt.")
        return 4
    try:
        r = Runner(mt5, config, ".")
        r.connect()
    except (RuntimeError, ValueError) as e:
        print(f"FEHLER: {e}")
        return 1
    text = r.diagnose_text()
    print(text)
    (r._logdir() / "diagnose.txt").write_text(text, encoding="utf-8")
    mt5.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
