"""Prüft jede Strategie gegen die Aufnahme-Checkliste (siehe STRATEGIE_CHECKLISTE.md) und sagt: ÜBERNEHMEN / BEOBACHTEN / ABLEHNEN.

Beispiel:
  python survey/pruefen.py --runs 1d 1d_2y --stress 1d_x2
  --runs     Ergebnisordner unter survey/out/ (je einer pro Zeitraum/Zeitrahmen, aus survey.py). Mindestens einer, besser zwei:
             Eine Strategie wird nur ÜBERNOMMEN, wenn sie in ALLEN angegebenen Läufen die Muss-Regeln erfüllt.
  --stress   Ordner eines Laufs mit doppelten Kosten (survey.py --cost-mult 2): dort darf die Strategie nicht ins Minus rutschen.
Ergebnis: survey/out/pruefung.txt (klein, zum Weitergeben).
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from survey.survey import summarize  # noqa: E402

OUT = Path(__file__).parent / "out"

# Muss-Regeln (alle erfüllt = Strategie ist für den Bot geeignet). Schwellen siehe STRATEGIE_CHECKLISTE.md.
MUST = {
    "maerkte": ("Getestete Märkte (mit genug Trades)", lambda r: r.maerkte >= 15, lambda r: f"{int(r.maerkte)} (min. 15)"),
    "trades": ("Trades gesamt über alle Märkte", lambda r: r.trades_total >= 150, lambda r: f"{int(r.trades_total)} (min. 150)"),
    "gewinn": ("Gewinn NACH Kosten (Median-Rendite)", lambda r: r.median_rendite > 0, lambda r: f"{r.median_rendite:+.1f} % (über 0)"),
    "pf": ("Profitfaktor nach Kosten (Median)", lambda r: r.median_profitfaktor >= 1.10, lambda r: f"{r.median_profitfaktor:.2f} (min. 1,10)"),
    "plus": ("Märkte im Plus", lambda r: r.pct_im_plus >= 60, lambda r: f"{r.pct_im_plus:.0f} % (min. 60)"),
    "winrate": ("Trefferquote netto über Break-even", lambda r: r.median_trefferquote >= r.breakeven + 5, lambda r: f"{r.median_trefferquote:.0f} % (Break-even {r.breakeven:.0f} % + 5)"),
}
# Soll-Regeln (erhöhen das Vertrauen; Verfehlen = nur Hinweis)
SHOULD = {
    "beide": ("Gewinn in beiden Zeithälften", lambda r: r.pct_beide_haelften_plus >= 40, lambda r: f"{r.pct_beide_haelften_plus:.0f} % der Märkte (min. 40)"),
    "sharpe": ("Sharpe (Median)", lambda r: r.median_sharpe >= 0.15, lambda r: f"{r.median_sharpe:.2f} (min. 0,15)"),
    "dd": ("Max. Drawdown (Median)", lambda r: r.median_maxdd <= 10, lambda r: f"{r.median_maxdd:.1f} % (max. 10)"),
    "freq": ("Handelshäufigkeit je Markt (Median)", lambda r: r.median_trades >= 15, lambda r: f"{r.median_trades:.0f} Trades (min. 15)"),
}
REFERENCE = ("breakout(lookback=55", "connors_rsi2(trend=200,rsi_period=2,oversold=5.0", "ma_pullback(ma_period=50,slope_bars=10", "ibs_reversion(low=0.2")


def breakeven(name: str) -> float:
    """Break-even-Trefferquote bei Stop/Ziel-Verhältnis rr (Ziel = rr x Stop): 1 / (1 + rr), in Prozent. Standard-rr = 2."""
    m = re.search(r"rr=([\d.]+)", name)
    rr = float(m.group(1)) if m else 2.0
    return 100.0 / (1.0 + rr)


def load(run: str, min_trades: int) -> pd.DataFrame:
    f = OUT / run / "alle_laeufe.csv"
    if not f.exists():
        raise SystemExit(f"Nicht gefunden: {f} – erst `python survey/survey.py ...` laufen lassen.")
    df = pd.read_csv(f)
    summ = summarize(df, min_trades)
    summ["trades_total"] = df[df.trades >= min_trades].groupby("strategie").trades.sum()
    summ["breakeven"] = [breakeven(n) for n in summ.index]
    return summ


def default_min_trades(run: str) -> int:
    """Gleiche Mindest-Trades je Lauf wie in survey.py (kurzer Zeitraum = weniger Trades möglich)."""
    if re.search(r"_\d+y", run):
        return 8
    return {"1d": 15, "4h": 25, "1h": 30, "1wk": 8}.get(run.split("_")[0], 15)


def evaluate(row, rules) -> dict:
    return {k: bool(fn(row)) for k, (_, fn, _) in rules.items()}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--runs", nargs="+", default=["1d"], help="Ergebnisordner, z. B. 1d 1d_2y")
    ap.add_argument("--stress", default="", help="Ergebnisordner mit doppelten Kosten, z. B. 1d_x2")
    ap.add_argument("--only", default="", help="nur Strategien, deren Name damit beginnt")
    a = ap.parse_args()

    runs = {r: load(r, default_min_trades(r)) for r in a.runs}
    stress = load(a.stress, default_min_trades(a.stress.replace("_x2", ""))) if a.stress else None
    names = sorted(set.intersection(*(set(s.index) for s in runs.values())))
    if a.only:
        names = [n for n in names if n.startswith(a.only)]

    rows = []
    for n in names:
        must = {r: evaluate(s.loc[n], MUST) for r, s in runs.items()}
        should = {r: evaluate(s.loc[n], SHOULD) for r, s in runs.items()}
        st_ok = None
        if stress is not None and n in stress.index:
            sr = stress.loc[n]
            st_ok = bool(sr.median_rendite > 0 and sr.median_profitfaktor >= 1.0)
        n_pass = sum(all(m.values()) for m in must.values())
        if n_pass == len(runs) and st_ok is not False:
            verdict = "ÜBERNEHMEN"
        elif n_pass >= 1 and st_ok is not False:
            verdict = "BEOBACHTEN"
        else:
            verdict = "ABLEHNEN"
        score = sum(sum(m.values()) for m in must.values()) * 10 + sum(sum(m.values()) for m in should.values()) + (5 if st_ok else 0)
        rows.append((n, verdict, must, should, st_ok, score))
    order = {"ÜBERNEHMEN": 0, "BEOBACHTEN": 1, "ABLEHNEN": 2}
    rows.sort(key=lambda r: (order[r[1]], -r[5]))

    L = ["PRÜFUNG GEGEN DIE AUFNAHME-CHECKLISTE", f"Läufe: {', '.join(runs)}" + (f"  |  Kostenstress: {a.stress}" if a.stress else "  |  (kein Kostenstress angegeben – empfohlen!)"), ""]
    L.append("Muss-Regeln: " + " | ".join(v[0] for v in MUST.values()))
    L.append("Soll-Regeln: " + " | ".join(v[0] for v in SHOULD.values()))
    L.append("Zeichen je Lauf: Muss ✔/✘ (6 Stellen)  Soll ✔/✘ (4 Stellen)   S = Kostenstress bestanden\n")
    L.append(f"{'Strategie':<64}{'Urteil':<12}" + "".join(f"{r[:9]:<20}" for r in runs) + "S")
    for n, verdict, must, should, st_ok, _ in rows:
        cells = ""
        for r in runs:
            cells += f"{''.join('✔' if v else '✘' for v in must[r].values())} {''.join('✔' if v else '✘' for v in should[r].values())}".ljust(20)
        ref = " *" if n.startswith(REFERENCE) else ""
        L.append(f"{n[:62]:<64}{verdict:<12}{cells}{'–' if st_ok is None else ('✔' if st_ok else '✘')}{ref}")
    L.append("\n* = Vorlage aus unseren bisherigen Strategien (Breakout 55/20, Connors RSI(2), Video-Methode 50/10, IBS) – daran orientiert sich die Latte.")

    top = [r for r in rows if r[1] == "ÜBERNEHMEN"]
    L += ["", f"DETAILS DER BESTEN ({min(len(top), 5) or 'keine übernehmbaren; zeige die besten Beobachtungen'})"]
    for n, verdict, must, should, st_ok, _ in (top or rows)[:5]:
        L.append(f"\n{n}  →  {verdict}")
        for r, s in runs.items():
            row = s.loc[n]
            L.append(f"  [{r}]")
            for key, (label, fn, show) in {**MUST, **SHOULD}.items():
                L.append(f"    {'✔' if fn(row) else '✘'} {label}: {show(row)}")
        if stress is not None and n in stress.index:
            sr = stress.loc[n]
            L.append(f"  [{a.stress}] Kostenstress: Median-Rendite {sr.median_rendite:+.1f} %, Profitfaktor {sr.median_profitfaktor:.2f} → {'bestanden' if st_ok else 'DURCHGEFALLEN'}")
    txt = "\n".join(L)
    (OUT / "pruefung.txt").write_text(txt, encoding="utf-8")
    print(txt)
    print(f"\nSchick mir diese Datei: {OUT / 'pruefung.txt'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
