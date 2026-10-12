"""Start: python -m mt5bot.run   (im Projektordner; MetaTrader 5 muss laufen, 'Algo-Handel' grün, Demo-Konto eingeloggt)."""
import sys

from .runner import Runner


def main() -> int:
    try:
        import MetaTrader5 as mt5
    except ImportError:
        print("FEHLER: Paket MetaTrader5 fehlt (nur Windows). Installieren mit:  pip install MetaTrader5")
        return 1
    try:
        Runner(mt5).run_forever()
    except RuntimeError as e:
        print(f"FEHLER: {e}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
