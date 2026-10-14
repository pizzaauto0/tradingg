"""Erzeugt aus der Nachprüfung fertige Profile für den MT5-Bot (zum Einfügen in mt5bot/config.py).

Beispiele (nach `python -m survey.nachpruefen`):
    python -m survey.profil_erzeugen --von nachpruefung_1d --auto 3        # die 3 besten ROBUSTEN, höchstens eine je Strategie-Typ
    python -m survey.profil_erzeugen --von nachpruefung_1d --wahl 2 5 7    # genau diese Nummern aus der Tabelle
Je Strategie werden NUR die Märkte eingetragen, auf denen sie in der Nachprüfung robust war (Profitfaktor ≥ 1,2 nach Kosten, im Plus).
Märkte, die dein Broker nicht anbietet, überspringt der Bot mit einer Warnung (Symbolnamen: SYMBOL_ALIASES / SYMBOL_SUFFIXES in der Konfiguration).
Stop und Ziel der Strategie (stop_mult, rr) gelten im Bot automatisch – genau so wurde getestet.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

OUT = Path(__file__).parent / "out"
# Test-Markt (Yahoo) -> typischer MetaTrader-Name (Alternativen: SYMBOL_ALIASES in mt5bot/config.py). None = beim CFD-Broker meist nicht handelbar.
MT5_NAMES = {
    "Gold": "XAUUSD", "Silber": "XAGUSD", "Platin": "XPTUSD", "Kupfer": "XCUUSD", "Rohöl": "USOIL", "Erdgas": "NATGAS",
    "S&P500": "US500", "Nasdaq100": "USTEC", "Dow": "US30", "Russell2000": "US2000", "DAX": "DE40", "Nikkei": "JP225", "Schwellenländer": None,
    "BTC": "BTCUSD", "ETH": "ETHUSD", "SOL": "SOLUSD", "XRP": "XRPUSD", "ADA": "ADAUSD", "DOGE": "DOGEUSD", "BNB": "BNBUSD", "LINK": "LINKUSD",
    "EURUSD": "EURUSD", "GBPUSD": "GBPUSD", "USDJPY": "USDJPY", "AUDUSD": "AUDUSD", "USDCHF": "USDCHF", "USDCAD": "USDCAD",
}
STOCKS = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "JPM", "XOM", "KO", "JNJ", "WMT", "NFLX", "AMD", "DIS"]
MT5_NAMES.update({t: t for t in STOCKS})


def short_name(item: dict) -> str:
    params = {k: v for k, v in item["params"].items()}
    return f"{item['type']}_{'_'.join(str(v).replace('.', '') for v in list(params.values())[:3])}"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--von", required=True, help="Ordner unter survey/out/ mit nachpruefung.json, z. B. nachpruefung_1d")
    ap.add_argument("--wahl", type=int, nargs="*", help="Nummern aus der Tabelle (ergebnisse.txt)")
    ap.add_argument("--auto", type=int, default=0, help="die N besten ROBUSTEN automatisch wählen (höchstens eine je Strategie-Typ)")
    ap.add_argument("--max-markets", type=int, default=8, help="höchstens so viele Märkte je Strategie (die mit dem besten Profitfaktor)")
    ap.add_argument("--timeframe", default="D1", help="Zeitrahmen im Bot (Standard D1 für Tageskerzen)")
    ap.add_argument("--risk", type=float, default=1.0)
    a = ap.parse_args()

    f = OUT / a.von / "nachpruefung.json"
    if not f.exists():
        print(f"Nicht gefunden: {f} – erst `python -m survey.nachpruefen` laufen lassen.")
        return 1
    items = json.loads(f.read_text(encoding="utf-8"))
    if a.wahl:
        chosen = [i for i in items if i["nr"] in a.wahl]
    elif a.auto:
        chosen, types = [], set()
        for i in items:
            if i["robust"] and i["type"] not in types and len(chosen) < a.auto:
                chosen.append(i)
                types.add(i["type"])
    else:
        print("Bitte --wahl <Nummern> oder --auto <Anzahl> angeben.")
        return 1
    if not chosen:
        print("Nichts ausgewählt (keine ROBUSTEN Strategien oder falsche Nummern).")
        return 1

    lines = ["# --- eingefügt von survey.profil_erzeugen: in mt5bot/config.py in die Liste PROFILES kopieren ---"]
    magic = 100201
    for i in chosen:
        mapped, skipped = [], []
        for m in i["robust_markets"]:
            (mapped if MT5_NAMES.get(m) else skipped).append(m)
        mapped = mapped[: a.max_markets]
        names = [MT5_NAMES[m] for m in mapped]
        lines += ["", "    {  # Nr " + str(i["nr"]) + ": " + i["name"],
                  "       # Nachprüfung: Profitfaktor {pf}, Edge gegen Zufall {edge:+.2f}, {tpy} Trades je Markt und Jahr, Jahre im Plus {yp}".format(
                      pf=i["pf"], edge=i["edge"], tpy=i["trades_per_year"], yp=i["years_positive"])]
        if skipped:
            lines.append("       # nicht eingetragen (kein typischer CFD-Markt): " + ", ".join(skipped))
        lines += [f'        "name": "{short_name(i)}", "enabled": True, "magic": {magic},',
                  f'        "markets": {{{", ".join(chr(34) + n + chr(34) + ": " + chr(34) + a.timeframe + chr(34) for n in names)}}},',
                  f'        "strategy": {json.dumps({"type": i["type"], "params": i["params"]}, ensure_ascii=False)},',
                  f'        "allow_short": False, "risk_percent": {a.risk}, "atr_stop_mult": 2.0, "rr": 2.0,  # Stop/Ziel der Strategie (stop_mult/rr) haben Vorrang', "    },"]
        magic += 1
    text = "\n".join(lines) + "\n"
    (OUT / "neues_profil.txt").write_text(text, encoding="utf-8")
    print(text)
    print(f"Gespeichert: {OUT / 'neues_profil.txt'}")
    print("Hinweise: Den alten Profil-Eintrag 'video' bei Bedarf auf \"enabled\": False setzen. MAX_OPEN_POSITIONS (Standard 3) begrenzt alle Profile gemeinsam.")
    print("Danach: Bot neu starten und mindestens 4 Wochen auf dem Demo-Konto beobachten (siehe STRATEGIE_CHECKLISTE.md, Abschnitt 7).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
