"""Tiefensuche: sucht gezielt über ein Zeitbudget (Standard 20 Minuten) die besten Parameter aller Strategie-Typen – ehrlich geprüft.

Start (im Projektordner):
    python -m survey.tiefensuche --interval 1d --minutes 20

Wie es vorgeht (gegen Überanpassung):
 1. Alle Märkte werden geladen (wie survey.py). Jede Zeitreihe wird in TRAINING (erste 60 %) und TEST (letzte 40 %) geteilt.
 2. Während der Suchzeit werden zufällige Parameter-Kombinationen aller Strategie-Typen auf ALLEN Märkten getestet.
    Bewertet wird nur das TRAINING (Profitfaktor nach Kosten, Märkte im Plus, genug Trades).
 3. Die Besten (Finalisten) werden dann auf dem unbekannten TEST geprüft, mit doppelten Kosten und mit leicht veränderten Parametern
    (Nachbarn). Ein echter Fund hält auf allen drei Prüfungen.
 4. Das Programm zeigt auch, wie viel von den Trainings-Spitzenwerten im Test übrig bleibt – das ist das ehrliche Maß für Zufallstreffer.
Ergebnis: survey/out/tiefensuche_<zeitrahmen>/ergebnisse.txt (zum Weitergeben), kandidaten.json, alle_konfigurationen.csv.
Das Programm handelt nicht.
"""
from __future__ import annotations

import argparse
import dataclasses
import json
import pickle
import random
import statistics
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from survey.survey import COSTS, UNIVERSE, WARMUP, demo_data, download  # noqa: E402
from tradingbot.backtest import Backtester  # noqa: E402
from tradingbot.config import load_config  # noqa: E402
from tradingbot.strategies import EXIT_SPEC, STRATEGY_TYPES, build_strategy  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SKIP_TYPES = {"session_breakout"}  # braucht Tageszeiten (nur Stunden-/Minutenkerzen)
RR_CHOICES, STOP_CHOICES = (1.0, 1.5, 2.0, 3.0), (1.5, 2.0, 3.0, 4.0)
G: dict = {}


# ---------------------------------------------------------------------------------------------------- Worker
def seg(trades, initial: float) -> dict:
    pnl = [t.pnl for t in trades]
    wins, losses = [x for x in pnl if x > 0], [-x for x in pnl if x <= 0]
    cum = np.cumsum(pnl) if pnl else np.array([0.0])
    dd = float((np.maximum.accumulate(cum) - cum).max() / initial * 100) if pnl else 0.0
    return {"n": len(pnl), "pf": (sum(wins) / sum(losses)) if losses and sum(losses) > 0 else (999.0 if wins else 0.0),
            "win": len(wins) / len(pnl) * 100 if pnl else 0.0, "ret": sum(pnl) / initial * 100, "dd": dd}


def init_worker(data_path: str, cfg_path: str, interval: str, train_frac: float) -> None:
    with open(data_path, "rb") as f:
        frames = pickle.load(f)
    base = load_config(cfg_path)
    G["frames"] = {}
    for name, (cls, df) in frames.items():
        bts = {}
        for mult in (1.0, 2.0):
            fee, slip = (c * mult for c in COSTS[cls])
            cfg = dataclasses.replace(base, market=dataclasses.replace(base.market, timeframe=interval),
                                      costs=dataclasses.replace(base.costs, fee_pct=fee, slippage_pct=slip))
            bts[mult] = Backtester(cfg)
        G["frames"][name] = (df, df.index[int(len(df) * train_frac)], bts)


def eval_batch(args):
    specs, mults = args
    result = []
    for spec in specs:
        try:
            strat = build_strategy(spec)
        except ValueError:
            continue
        out = {}
        for name, (df, cut, bts) in G["frames"].items():
            for mult in mults:
                try:
                    res = bts[mult].run(df, strat, symbol=name)
                except Exception:  # einzelne Strategie scheitert -> Markt überspringen
                    continue
                init = bts[mult].cfg.capital.start
                out[(name, mult)] = (seg([t for t in res.trades if t.entry_time < cut], init), seg([t for t in res.trades if t.entry_time >= cut], init))
        result.append((spec, out))
    return result


# ---------------------------------------------------------------------------------------------------- Suche
def spec_key(spec: dict) -> str:
    return json.dumps({"type": spec["type"], "params": spec["params"]}, sort_keys=True)


def sample_spec(rng: random.Random, types: list[str]) -> dict | None:
    t = rng.choice(types)
    cls = STRATEGY_TYPES[t]
    params = {}
    for key, (typ, lo, hi) in cls.param_spec.items():
        params[key] = rng.randint(int(lo), int(hi)) if typ is int else round(rng.uniform(lo, hi), 2)
    if rng.random() < 0.6:
        params["stop_mult"], params["rr"] = rng.choice(STOP_CHOICES), rng.choice(RR_CHOICES)
    spec = {"type": t, "params": params}
    try:
        build_strategy(spec)
    except ValueError:
        return None
    return spec


def neighbors(spec: dict) -> list[dict]:
    """Leicht veränderte Parameter (±15 %): ein echter Fund bricht dabei nicht zusammen."""
    cls, out, seen = STRATEGY_TYPES[spec["type"]], [], {spec_key(spec)}
    for key, val in spec["params"].items():
        bounds = cls.param_spec.get(key) or EXIT_SPEC.get(key)
        if not bounds:
            continue
        typ, lo, hi = bounds
        for f in (0.85, 1.15):
            v = val * f
            v = int(round(v)) if typ is int else round(v, 2)
            v = min(max(v, typ(lo)), typ(hi))
            if v == val:
                continue
            cand = {"type": spec["type"], "params": {**spec["params"], key: v}}
            try:
                build_strategy(cand)
            except ValueError:
                continue
            if spec_key(cand) not in seen:
                seen.add(spec_key(cand))
                out.append(cand)
    return out


def aggregate(out: dict, part: int, mult: float, min_trades: int) -> dict:
    rows = [segs[part] for (name, m), segs in out.items() if m == mult and segs[part]["n"] >= min_trades]
    if not rows:
        return {"markets": 0, "pf": 0.0, "plus": 0.0, "trades": 0, "ret": 0.0, "win": 0.0, "dd": 0.0}
    return {"markets": len(rows), "pf": statistics.median(min(r["pf"], 20) for r in rows), "plus": sum(r["ret"] > 0 for r in rows) / len(rows) * 100,
            "trades": sum(r["n"] for r in rows), "ret": statistics.median(r["ret"] for r in rows), "win": statistics.median(r["win"] for r in rows),
            "dd": statistics.median(r["dd"] for r in rows)}


def train_score(a: dict) -> float:
    """Nur aus dem TRAINING: Profitfaktor, gewichtet mit dem Anteil der Märkte im Plus; zu wenige Märkte/Trades zählen nicht."""
    if a["markets"] < 12 or a["trades"] < 150:
        return 0.0
    return min(a["pf"], 3.0) * (0.5 + 0.5 * a["plus"] / 100)


def name_of(spec: dict) -> str:
    return build_strategy(spec).name


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--interval", default="1d", choices=["1d", "4h", "1h"])
    ap.add_argument("--minutes", type=float, default=20.0, help="Suchzeit in Minuten (Standard 20)")
    ap.add_argument("--workers", type=int, default=0)
    ap.add_argument("--train-frac", type=float, default=0.6)
    ap.add_argument("--finalists", type=int, default=25)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--config", default=str(ROOT / "config.yaml"))
    ap.add_argument("--demo", action="store_true", help="Zufallsdaten statt Download (nur Funktionstest)")
    ap.add_argument("--limit", type=int, default=0, help="nur die ersten N Märkte (Test)")
    a = ap.parse_args()

    out_dir = Path(__file__).parent / "out" / (("demo_" if a.demo else "") + f"tiefensuche_{a.interval}")
    out_dir.mkdir(parents=True, exist_ok=True)
    cache = Path(__file__).parent / "cache"
    min_tr, min_te = (10, 6) if a.interval == "1d" else (20, 12)

    items = [(c, n, t) for c, m in UNIVERSE.items() for n, t in m.items()]
    if a.limit:
        items = items[: a.limit]
    frames, missing = {}, []
    for i, (cls, name, ticker) in enumerate(items, 1):
        print(f"[{i}/{len(items)}] Daten {name} …", flush=True)
        df = demo_data(i, 2500 if a.interval == "1d" else 8000) if a.demo else download(ticker, a.interval, cache)
        if df is None or len(df) < WARMUP + 300:
            missing.append(name)
            continue
        frames[name] = (cls, df)
    if len(frames) < 5:
        print("Zu wenige Märkte geladen – Verbindung / yfinance prüfen.")
        return 1
    data_path = out_dir / "_daten.pkl"
    with open(data_path, "wb") as f:
        pickle.dump(frames, f)
    any_df = next(iter(frames.values()))[1]
    print(f"\n{len(frames)} Märkte geladen. Training = erste {a.train_frac * 100:.0f} %, Test = letzte {100 - a.train_frac * 100:.0f} % jeder Reihe "
          f"(z. B. {any_df.index[0]:%Y-%m-%d} … {any_df.index[int(len(any_df) * a.train_frac)]:%Y-%m-%d} | Test bis {any_df.index[-1]:%Y-%m-%d}).")

    rng = random.Random(a.seed)
    types = [t for t in STRATEGY_TYPES if t not in SKIP_TYPES]
    workers = a.workers or None
    results: dict[str, tuple[dict, dict]] = {}   # key -> (spec, out)
    t0, deadline = time.monotonic(), time.monotonic() + a.minutes * 60
    rounds, best, last_print = 0, (0.0, ""), 0.0
    print(f"\nSuche läuft {a.minutes:g} Minuten (Strg+C = vorzeitig beenden und mit dem bisher Gefundenen auswerten) …\n", flush=True)
    with ProcessPoolExecutor(max_workers=workers, initializer=init_worker, initargs=(str(data_path), a.config, a.interval, a.train_frac)) as ex:
        n_workers = ex._max_workers
        try:
            seeds = [{"type": t, "params": json.loads(json.dumps(build_strategy({"type": t, "params": _defaults(t)}).to_spec()["params"]))} for t in types if _defaults(t)]
            first = True
            while time.monotonic() < deadline:
                batch = []
                if first:
                    batch += seeds
                    first = False
                while len(batch) < n_workers * 6:
                    s = sample_spec(rng, types)
                    if s and spec_key(s) not in results and spec_key(s) not in {spec_key(b) for b in batch}:
                        batch.append(s)
                chunks = [batch[i::n_workers] for i in range(n_workers)]
                for res in ex.map(eval_batch, [(c, (1.0,)) for c in chunks]):
                    for spec, out in res:
                        results[spec_key(spec)] = (spec, out)
                        sc = train_score(aggregate(out, 0, 1.0, min_tr))
                        if sc > best[0]:
                            best = (sc, name_of(spec))
                rounds += 1
                el = time.monotonic() - t0
                if time.monotonic() - last_print < 20 and time.monotonic() < deadline:
                    continue
                last_print = time.monotonic()
                print(f"  {el / 60:5.1f} von {a.minutes:g} min | {len(results)} Konfigurationen getestet | bester Trainings-Wert {best[0]:.2f}: {best[1][:60]}", flush=True)
        except KeyboardInterrupt:
            print("\nSuche vorzeitig beendet – werte bisher Gefundenes aus …")

        # ---- Phase 2: Finalisten prüfen ----
        print(f"\nSuche beendet: {len(results)} Konfigurationen in {(time.monotonic() - t0) / 60:.1f} min. Prüfe die besten auf dem unbekannten Test …", flush=True)
        scored = sorted(((train_score(aggregate(out, 0, 1.0, min_tr)), key) for key, (spec, out) in results.items()), reverse=True)
        finalists, per_type = [], {}
        for sc, key in scored:
            spec = results[key][0]
            if sc <= 0 or per_type.get(spec["type"], 0) >= 3:  # höchstens 3 je Typ: sonst besteht die Liste nur aus einem Typ
                continue
            per_type[spec["type"]] = per_type.get(spec["type"], 0) + 1
            finalists.append(spec)
            if len(finalists) >= a.finalists:
                break
        fin_chunks = [finalists[i::n_workers] for i in range(n_workers)]
        stress = {spec_key(s): out for chunk in ex.map(eval_batch, [(c, (2.0,)) for c in fin_chunks]) for s, out in chunk}
        nb_specs = {spec_key(f): neighbors(f) for f in finalists}  # Nachbar-Prüfung für ALLE Finalisten
        flat = [n for v in nb_specs.values() for n in v]
        nb_chunks = [flat[i::n_workers] for i in range(n_workers)]
        nb_out = {spec_key(s): out for chunk in ex.map(eval_batch, [(c, (1.0,)) for c in nb_chunks]) for s, out in chunk}

    # ---- Auswertung ----
    base_test = [aggregate(out, 1, 1.0, min_te) for _, out in results.values()]
    base_pf = statistics.median(b["pf"] for b in base_test if b["markets"]) if any(b["markets"] for b in base_test) else 0.0
    rows, candidates = [], []
    for spec in finalists:
        k = spec_key(spec)
        out = results[k][1]
        tr, te = aggregate(out, 0, 1.0, min_tr), aggregate(out, 1, 1.0, min_te)
        st = aggregate(stress[k], 1, 2.0, min_te) if k in stress else None
        nbs = [aggregate(nb_out[spec_key(n)], 1, 1.0, min_te) for n in nb_specs.get(k, []) if spec_key(n) in nb_out]
        nb_pf = statistics.median(n["pf"] for n in nbs if n["markets"]) if any(n["markets"] for n in nbs) else None
        ok_test = te["pf"] >= 1.10 and te["plus"] >= 60 and te["trades"] >= 100 and te["ret"] > 0 and te["markets"] >= 12
        ok_stress = st is not None and st["pf"] >= 1.0 and st["ret"] > 0
        ok_nb = nb_pf is not None and nb_pf >= 1.05
        verdict = "KANDIDAT" if ok_test and ok_stress and ok_nb else ("WACKELIG" if ok_test else "VERWORFEN")
        rows.append((spec, tr, te, st, nb_pf, verdict, ok_test, ok_stress, ok_nb))
        if verdict == "KANDIDAT":
            candidates.append({"type": spec["type"], "params": spec["params"], "train_pf": round(tr["pf"], 2), "test_pf": round(te["pf"], 2),
                               "test_plus_pct": round(te["plus"]), "stress_pf": round(st["pf"], 2) if st else None})
    held = sum(1 for r in rows if r[2]["pf"] >= 1.10 and r[2]["plus"] >= 60)

    L = [f"TIEFENSUCHE  Zeitrahmen {a.interval}  |  {len(frames)} Märkte  |  {len(results)} Konfigurationen in {a.minutes:g} min Suchzeit",
         f"Training = erste {a.train_frac * 100:.0f} % jeder Reihe (hier wurde gesucht), Test = letzte {100 - a.train_frac * 100:.0f} % (unbekannt, nur zur Prüfung). Alle Werte nach Kosten.", "",
         "EHRLICHKEITS-CHECK (wichtig)",
         f"  Von den {len(rows)} besten Trainings-Konfigurationen halten im unbekannten Test nur {held} (Profitfaktor ≥ 1,10 und ≥ 60 % der Märkte im Plus).",
         f"  Median-Profitfaktor ALLER getesteten Konfigurationen im Test: {base_pf:.2f} (= was reiner Zufall/Durchschnitt bringt).",
         f"  Trainings-PF der Finalisten (Median) {statistics.median(r[1]['pf'] for r in rows) if rows else 0:.2f} → Test-PF {statistics.median(r[2]['pf'] for r in rows) if rows else 0:.2f}: "
         "Dieser Abstand ist der Preis des Suchens (Überanpassung).", "",
         f"{'Strategie (Parameter)':<72}{'Train PF/Plus/Trd':<22}{'TEST PF/Plus/Trd':<22}{'Stress PF':<10}{'Nachb.':<8}Urteil"]
    def trio(x):
        return f"{x['pf']:.2f}/{x['plus']:.0f}%/{x['trades']}"

    for spec, tr, te, st, nb_pf, verdict, *_ in sorted(rows, key=lambda r: ({"KANDIDAT": 0, "WACKELIG": 1, "VERWORFEN": 2}[r[5]], -r[2]["pf"])):
        st_txt = "{:.2f}".format(st["pf"]) if st else "–"
        nb_txt = "{:.2f}".format(nb_pf) if nb_pf is not None else "–"
        L.append("{:<72}{:<22}{:<22}{:<10}{:<8}{}".format(name_of(spec)[:70], trio(tr), trio(te), st_txt, nb_txt, verdict))
    L += ["", "Urteil: KANDIDAT = Test (PF ≥ 1,10, ≥ 60 % der Märkte im Plus, ≥ 100 Trades), Kostenstress (doppelte Kosten: PF ≥ 1,0) und Nachbar-Parameter (PF ≥ 1,05) bestanden.",
          "        WACKELIG = Test bestanden, aber Kostenstress oder Nachbarn nicht. VERWORFEN = im Test durchgefallen (Zufallstreffer).", "",
          f"KANDIDATEN: {len(candidates)}" + ("  (Details in kandidaten.json – als Profil in mt5bot/config.py einsetzbar, danach survey.pruefen und Demo-Abnahme)" if candidates else
                                              "  – keiner. Das ist ein gültiges Ergebnis: auf diesen Daten gibt es keine robuste Verbesserung gegenüber unseren bisherigen Strategien.")]
    txt = "\n".join(L)
    (out_dir / "ergebnisse.txt").write_text(txt, encoding="utf-8")
    (out_dir / "kandidaten.json").write_text(json.dumps(candidates, indent=2), encoding="utf-8")
    flat_rows = []
    for k, (spec, out) in results.items():
        tr, te = aggregate(out, 0, 1.0, min_tr), aggregate(out, 1, 1.0, min_te)
        flat_rows.append({"strategie": name_of(spec), "train_score": round(train_score(tr), 3), **{f"train_{x}": tr[x] for x in ("markets", "pf", "plus", "trades")},
                          **{f"test_{x}": te[x] for x in ("markets", "pf", "plus", "trades")}})
    pd.DataFrame(flat_rows).sort_values("train_score", ascending=False).to_csv(out_dir / "alle_konfigurationen.csv", index=False, float_format="%.3f")
    data_path.unlink(missing_ok=True)
    print("\n" + txt + f"\n\nFERTIG. Schick mir diese Datei: {out_dir / 'ergebnisse.txt'}")
    return 0


def _defaults(t: str) -> dict:
    """Standard-Parameter des Typs aus der festen Liste (damit die bekannten Varianten sicher mitgetestet werden)."""
    from tradingbot.strategies import DEFAULT_SPECS
    return next((p for tt, p in DEFAULT_SPECS if tt == t), {})


if __name__ == "__main__":
    sys.exit(main())
