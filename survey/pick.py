"""Welche Märkte passen zu welcher Strategie? Liest survey/out/<interval>/alle_laeufe.csv und schreibt markt_auswahl.txt.

Start:  python survey/pick.py --interval 1d
Ein Markt gilt für eine Strategie als 'robust', wenn: genug Trades, Gewinn in BEIDEN Zeithälften, Profitfaktor >= 1,2.
Je mehr Strategien einen Markt als robust sehen, desto besser passt er zum Strategie-Set.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import pandas as pd

PICKS = {  # Kurzname -> Anfang des Strategienamens
    "Breakout 55/20": "breakout(lookback=55",
    "Connors RSI(2) Stop3/RR1": "connors_rsi2(trend=200,rsi_period=2,oversold=5.0",
    "IBS 0,2/0,8": "ibs_reversion(low=0.2",
    "Trend-Pullback 200": "trend_pullback(trend=200",
    "Range-Support": "range_support(",
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--interval", default="1d")
    ap.add_argument("--min-trades", type=int, default=0)
    ap.add_argument("--min-pf", type=float, default=1.2)
    a = ap.parse_args()
    out = Path(__file__).parent / "out" / a.interval
    df = pd.read_csv(out / "alle_laeufe.csv")
    mt = a.min_trades or (8 if "y" in a.interval else {"1d": 15, "1h": 30, "1wk": 8}.get(a.interval, 15))
    df["robust"] = (df.trades >= mt) & (df.ret_h1 > 0) & (df.ret_h2 > 0) & (df.profitfaktor >= a.min_pf)
    L = [f"MARKT-AUSWAHL  {a.interval}  (robust = >= {mt} Trades, Gewinn in beiden Zeithälften, Profitfaktor >= {a.min_pf})", ""]
    table = {}
    for label, prefix in PICKS.items():
        d = df[df.strategie.str.startswith(prefix)].copy()
        if d.empty:
            continue
        table[label] = d.set_index("markt").robust
        d["score"] = d[["ret_h1", "ret_h2"]].min(axis=1) + d.sharpe * 5
        L.append(f"== {label}: robust auf {int(d.robust.sum())} von {len(d)} Märkten ==")
        L.append(f"{'Markt':<14}{'Klasse':<9}{'rob':>4}{'Sharpe':>7}{'Rend%':>8}{'H1%':>7}{'H2%':>7}{'PF':>6}{'Treff%':>7}{'Trd':>5}{'DD%':>6}")
        for _, r in d.sort_values(["robust", "score"], ascending=False).head(14).iterrows():
            L.append(f"{r.markt:<14}{r.klasse:<9}{'ja' if r.robust else '':>4}{r.sharpe:>7.2f}{r.rendite_pct:>8.1f}{r.ret_h1:>7.1f}{r.ret_h2:>7.1f}{r.profitfaktor:>6.2f}{r.trefferquote_pct:>7.0f}{int(r.trades):>5}{r.maxdd_pct:>6.1f}")
        L.append("")
    m = pd.DataFrame(table).fillna(False)
    m["anzahl"] = m.sum(axis=1)
    cls = df.drop_duplicates("markt").set_index("markt").klasse
    L.append("== MÄRKTE NACH ANZAHL ROBUSTER STRATEGIEN (beste zuerst) ==")
    for name, r in m.sort_values("anzahl", ascending=False).head(20).iterrows():
        L.append(f"{name:<14}{cls.get(name, ''):<9}{int(r.anzahl)}/{len(table)}  " + ", ".join(k for k in table if r[k]))
    txt = "\n".join(L)
    (out / "markt_auswahl.txt").write_text(txt, encoding="utf-8")
    print(txt)
    print(f"\nSchick mir diese Datei: {out / 'markt_auswahl.txt'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
