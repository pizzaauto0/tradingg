"""Nachprüfung der Kandidaten der Tiefensuche – klärt, ob der Erfolg echt ist oder nur vom günstigen Zeitraum kommt.

Start (im Projektordner, nach der Tiefensuche):
    python -m survey.nachpruefen --interval 1d
(liest survey/out/tiefensuche_<zeitrahmen>/kandidaten.json oder, mit --from-csv, die besten Konfigurationen aus alle_konfigurationen.csv)

Prüft je Strategie über die GANZE Reihe (nicht nur den Test):
 1. EDGE GEGEN ZUFALL: dieselben Ausstiege (Stop, Ziel, Ausstiegsregel), aber ZUFÄLLIGE Einstiege mit ähnlich vielen Trades.
    Ist die Strategie nicht deutlich besser als das, kommt der Gewinn nur aus dem steigenden Markt und der Stop-Struktur.
 2. JAHRE IM PLUS: durchschnittliche Rendite je Kalenderjahr über alle Märkte; wie viele Jahre positiv, wie schlecht das schlechteste Jahr.
 3. HANDELSHÄUFIGKEIT: Trades je Markt und Jahr (sehr seltene Strategien haben kaum Aussagekraft und handeln kaum).
 4. DRAWDOWN (Median/schlechtester Markt) und PARAMETER-NACHBARN (±15 %).
Ergebnis: survey/out/nachpruefung_<zeitrahmen>/ergebnisse.txt
"""
from __future__ import annotations

import argparse
import json
import pickle
import random
import statistics
import sys
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from survey import tiefensuche as T  # noqa: E402
from survey.survey import UNIVERSE, WARMUP, demo_data, download  # noqa: E402
from tradingbot.strategies import build_strategy  # noqa: E402

N_RANDOM = 5


class RandomEntry:
    """Gleiche Ausstiege wie die echte Strategie, aber Einstiege per Zufall (Vergleichsmaßstab)."""

    def __init__(self, strat, p: float, seed: int):
        self.s, self.p, self.rng = strat, p, np.random.default_rng(seed)
        self.regimes = ("uptrend", "downtrend", "sideways")
        self.name = "zufall"

    def entry(self, df):
        return pd.Series(self.rng.random(len(df)) < self.p, index=df.index)

    def exit(self, df):
        return self.s.exit(df)

    def stop_mult(self, d):
        return self.s.stop_mult(d)

    def rr(self, d):
        return self.s.rr(d)


def run_stats(res, initial: float) -> dict:
    tr = res.trades
    pnl = [t.pnl for t in tr]
    wins, losses = [x for x in pnl if x > 0], [-x for x in pnl if x <= 0]
    cum = np.cumsum(pnl) if pnl else np.array([0.0])
    years: dict[int, float] = defaultdict(float)
    for t in tr:
        years[t.entry_time.year] += t.pnl / initial * 100
    return {"n": len(pnl), "pf": (sum(wins) / sum(losses)) if losses and sum(losses) > 0 else (999.0 if wins else 0.0),
            "ret": sum(pnl) / initial * 100, "dd": float((np.maximum.accumulate(cum) - cum).max() / initial * 100) if pnl else 0.0, "years": dict(years)}


def check_one(args):
    spec, with_baseline = args
    try:
        strat = build_strategy(spec)
    except ValueError:
        return spec, {}
    out = {}
    for name, (df, cut, bts) in T.G["frames"].items():
        bt = bts[1.0]
        try:
            res = bt.run(df, strat, symbol=name)
        except Exception:
            continue
        st = run_stats(res, bt.cfg.capital.start)
        if with_baseline:
            p = min(0.25, max(0.002, 1.5 * st["n"] / max(len(df), 1)))
            pfs = []
            for seed in range(N_RANDOM):
                try:
                    pfs.append(run_stats(bt.run(df, RandomEntry(strat, p, seed), symbol=name), bt.cfg.capital.start)["pf"])
                except Exception:
                    pass
            st["base_pf"] = statistics.median(min(x, 20) for x in pfs) if pfs else None
        st["bars"] = len(df)
        st["span_years"] = (df.index[-1] - df.index[0]).days / 365.25
        out[name] = st
    return spec, out


def summarize_spec(out: dict, min_trades: int) -> dict:
    rows = {k: v for k, v in out.items() if v["n"] >= min_trades}
    if len(rows) < 8:
        return {"markets": len(rows)}
    pf = statistics.median(min(v["pf"], 20) for v in rows.values())
    base = [v["base_pf"] for v in rows.values() if v.get("base_pf") is not None]
    years: dict[int, list] = defaultdict(list)
    for v in out.values():
        for y, r in v["years"].items():
            years[y].append(r)
    yr = {y: statistics.mean(r) for y, r in years.items() if len(r) >= 8 and y not in (min(years),)}  # erstes (Teil-)Jahr auslassen
    robust_markets = sorted((k for k, v in rows.items() if v["pf"] >= 1.2 and v["ret"] > 0), key=lambda k: -rows[k]["pf"])
    return {"robust_markets": robust_markets, "markets": len(rows), "pf": pf, "base_pf": statistics.median(base) if base else None, "plus": sum(v["ret"] > 0 for v in rows.values()) / len(rows) * 100,
            "years_pos": sum(r > 0 for r in yr.values()), "years_n": len(yr), "worst_year": min(yr.values()) if yr else 0.0,
            "worst_year_n": min(yr, key=yr.get) if yr else None, "per_year": statistics.median(v["n"] / v["span_years"] for v in rows.values()),
            "dd_med": statistics.median(v["dd"] for v in rows.values()), "dd_worst": max(v["dd"] for v in rows.values())}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--interval", default="1d", choices=["1d", "4h", "1h"])
    ap.add_argument("--specs", default="kandidaten", help="kandidaten (Standard: kandidaten.json der Tiefensuche) | defaults (alle bisherigen Standard-Strategien des Bots, "
                    "z. B. um die Video-Methode und die Final-3 gegen Zufall zu prüfen) | Pfad zu einer JSON-Datei mit [{type, params}, ...]")
    ap.add_argument("--workers", type=int, default=0)
    ap.add_argument("--config", default=str(T.ROOT / "config.yaml"))
    ap.add_argument("--demo", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    src = Path(__file__).parent / "out" / (("demo_" if a.demo else "") + f"tiefensuche_{a.interval}")
    tag = "" if a.specs == "kandidaten" else "_" + Path(a.specs).stem
    out_dir = Path(__file__).parent / "out" / (("demo_" if a.demo else "") + f"nachpruefung_{a.interval}{tag}")
    out_dir.mkdir(parents=True, exist_ok=True)
    if a.specs == "defaults":
        from tradingbot.strategies import DEFAULT_SPECS
        specs = [{"type": t, "params": p} for t, p in DEFAULT_SPECS]
    elif a.specs == "kandidaten":
        cands = json.loads((src / "kandidaten.json").read_text(encoding="utf-8")) if (src / "kandidaten.json").exists() else []
        specs = [{"type": c["type"], "params": c["params"]} for c in cands]
    else:
        specs = [{"type": c["type"], "params": c["params"]} for c in json.loads(Path(a.specs).read_text(encoding="utf-8"))]
    if not specs:
        print(f"Keine Kandidaten in {src / 'kandidaten.json'} – erst `python -m survey.tiefensuche` laufen lassen (oder keiner hat bestanden).")
        return 1

    items = [(c, n, t) for c, m in UNIVERSE.items() for n, t in m.items()]
    if a.limit:
        items = items[: a.limit]
    frames = {}
    for i, (cls, name, ticker) in enumerate(items, 1):
        print(f"[{i}/{len(items)}] Daten {name} …", flush=True)
        df = demo_data(i, 2500 if a.interval == "1d" else 8000) if a.demo else download(ticker, a.interval, Path(__file__).parent / "cache")
        if df is not None and len(df) >= WARMUP + 300:
            frames[name] = (cls, df)
    data_path = out_dir / "_daten.pkl"
    data_path.write_bytes(pickle.dumps(frames))
    min_trades = 6 if a.interval == "1d" else 12

    print(f"\nPrüfe {len(specs)} Kandidaten auf {len(frames)} Märkten (Zufalls-Vergleich, Jahre, Nachbarn) …", flush=True)
    with ProcessPoolExecutor(max_workers=a.workers or None, initializer=T.init_worker, initargs=(str(data_path), a.config, a.interval, 0.6)) as ex:
        main_res = {T.spec_key(s): (s, o) for s, o in ex.map(check_one, [(s, True) for s in specs])}
        nb_list = {T.spec_key(s): T.neighbors(s) for s in specs}
        flat = [n for v in nb_list.values() for n in v]
        nb_res = {T.spec_key(s): o for s, o in ex.map(check_one, [(n, False) for n in flat])}
    data_path.unlink(missing_ok=True)

    L = [f"NACHPRÜFUNG DER KANDIDATEN  Zeitrahmen {a.interval}  |  {len(frames)} Märkte  |  {len(specs)} Kandidaten", "",
         "Spalten: PF = Profitfaktor nach Kosten (ganze Reihe) | Zufall = PF mit zufälligen Einstiegen und denselben Ausstiegen | Edge = PF minus Zufall |",
         "Jahre+ = Kalenderjahre mit positiver Durchschnittsrendite | Schlecht. = schlechtestes Jahr | T/J = Trades je Markt und Jahr | Nachb. = PF der Nachbar-Parameter (Median)", "",
         "{:>2} {:<61}{:>5}{:>7}{:>6}{:>8}{:>16}{:>5}{:>7}{:>7}  Urteil".format("Nr", "Strategie", "PF", "Zufall", "Edge", "Jahre+", "Schlecht.", "T/J", "DDmed", "Nachb.")]
    rows = []
    for k, (spec, out) in main_res.items():
        sm = summarize_spec(out, min_trades)
        if sm.get("pf") is None:
            continue
        nbs = [summarize_spec(nb_res[T.spec_key(n)], min_trades) for n in nb_list[k] if T.spec_key(n) in nb_res]
        nb_pf = statistics.median(n["pf"] for n in nbs if n.get("pf") is not None) if any(n.get("pf") is not None for n in nbs) else None
        edge = sm["pf"] - (sm["base_pf"] or 0)
        notes = []
        if edge < 0.20:
            notes.append("kaum besser als Zufall")
        if sm["years_n"] and sm["years_pos"] / sm["years_n"] < 0.7:
            notes.append("schwache Jahre")
        if nb_pf is None or nb_pf < 1.05:
            notes.append("Nachbarn brechen ein")
        if sm["per_year"] < 2:
            notes.append("sehr selten")
        solid = edge >= 0.20 and sm["years_n"] and sm["years_pos"] / sm["years_n"] >= 0.7 and nb_pf is not None and nb_pf >= 1.05
        verdict = ("ROBUST" if solid and sm["per_year"] >= 2 else "ROBUST, ABER SELTEN" if solid else "SCHWACH: " + ", ".join(notes))
        rows.append((spec, sm, nb_pf, edge, verdict, solid))
    rows.sort(key=lambda r: (not r[5], -r[3]))
    export = []
    for nr, (spec, sm, nb_pf, edge, verdict, solid) in enumerate(rows, 1):
        export.append({"nr": nr, "type": spec["type"], "params": spec["params"], "name": build_strategy(spec).name, "verdict": verdict, "robust": bool(solid),
                       "pf": round(sm["pf"], 3), "edge": round(edge, 3), "trades_per_year": round(sm["per_year"], 2), "years_positive": f"{sm['years_pos']}/{sm['years_n']}",
                       "robust_markets": sm["robust_markets"]})
    (out_dir / "nachpruefung.json").write_text(json.dumps(export, indent=2, ensure_ascii=False), encoding="utf-8")
    for nr, (spec, sm, nb_pf, edge, verdict, _) in enumerate(rows, 1):
        yrs = "{}/{}".format(sm["years_pos"], sm["years_n"])
        worst = "{:+.1f}% ({})".format(sm["worst_year"], sm["worst_year_n"])
        L.append("{:>2} {:<61}{:>5.2f}{:>7.2f}{:>+6.2f}{:>8}{:>16}{:>5.1f}{:>6.1f}%{:>7.2f}  {}".format(
            nr, build_strategy(spec).name[:60], sm["pf"], sm["base_pf"] or 0, edge, yrs, worst, sm["per_year"], sm["dd_med"], nb_pf if nb_pf is not None else 0, verdict))
    robust = [r for r in rows if r[5]]
    L += ["", f"ROBUST: {len(robust)} von {len(rows)}. 'Edge' zeigt, wie viel die Einstiegs-Idee wirklich beiträgt: Ist er klein, steckt der Gewinn im Markt (steigende Kurse) und in der Stop-Struktur, nicht in der Strategie.",
          "Wichtig: Wenige Trades je Markt und Jahr (T/J < 2) heißen, dass der Bot kaum handelt und jede Aussage auf wenigen Trades beruht."]
    L += ["", "Weiter: Profil für den MT5-Bot erzeugen, z. B.   python -m survey.profil_erzeugen --von " + out_dir.name + " --wahl 1 2 3    (oder --auto 3)"]
    txt = "\n".join(L)
    (out_dir / "ergebnisse.txt").write_text(txt, encoding="utf-8")
    print("\n" + txt + f"\n\nFERTIG. Schick mir diese Datei: {out_dir / 'ergebnisse.txt'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
