"""Massen-Test: alle Strategien des Bots auf vielen Märkten (Krypto, Gold, Silber, Rohstoffe, Aktien, Indizes, Forex).

Start (im Projektordner):  python survey/survey.py --interval 1d          # ca. 10 Jahre Tageskerzen
                           python survey/survey.py --interval 1h          # ca. 2 Jahre Stundenkerzen
Ergebnis: survey/out/<interval>/ergebnisse.txt  <- diese kleine Datei schickst du mir.
Kursdaten: Yahoo Finance über das Paket yfinance (kostenlos, ohne Konto). Heruntergeladene Daten werden zwischengespeichert.
Das Programm handelt nicht und braucht keine Schlüssel.
"""
from __future__ import annotations

import argparse
import dataclasses
import sys
import time
import warnings
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
warnings.filterwarnings("ignore")

from tradingbot.backtest import WARMUP, Backtester  # noqa: E402
from tradingbot.config import load_config  # noqa: E402
from tradingbot.strategies import DEFAULT_SPECS, build_strategy  # noqa: E402

# Klasse -> {Anzeigename: Yahoo-Ticker}
UNIVERSE: dict[str, dict[str, str]] = {
    "Krypto": {"BTC": "BTC-USD", "ETH": "ETH-USD", "SOL": "SOL-USD", "XRP": "XRP-USD", "ADA": "ADA-USD", "DOGE": "DOGE-USD", "BNB": "BNB-USD", "LINK": "LINK-USD"},
    "Metalle": {"Gold": "GC=F", "Silber": "SI=F", "Kupfer": "HG=F", "Platin": "PL=F"},
    "Energie": {"Rohöl": "CL=F", "Erdgas": "NG=F"},
    "Indizes": {"S&P500": "SPY", "Nasdaq100": "QQQ", "Dow": "DIA", "Russell2000": "IWM", "DAX": "^GDAXI", "Nikkei": "^N225", "Schwellenländer": "EEM"},
    "Aktien": {k: k for k in ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "JPM", "XOM", "KO", "JNJ", "WMT", "NFLX", "AMD", "DIS"]},
    "Forex": {"EURUSD": "EURUSD=X", "GBPUSD": "GBPUSD=X", "USDJPY": "USDJPY=X", "AUDUSD": "AUDUSD=X", "USDCHF": "USDCHF=X", "USDCAD": "USDCAD=X"},
}
# Kosten je Seite in Prozent (Gebühr, Slippage): grobe, bewusst nicht zu optimistische Annahmen
COSTS = {"Krypto": (0.10, 0.05), "Metalle": (0.03, 0.03), "Energie": (0.03, 0.05), "Indizes": (0.02, 0.02), "Aktien": (0.02, 0.03), "Forex": (0.005, 0.01)}
PERIOD = {"1d": "10y", "1h": "730d", "1wk": "max"}


def download(ticker: str, interval: str, cache: Path) -> pd.DataFrame | None:
    f = cache / f"{ticker.replace('^', '_').replace('=', '_')}_{interval}.csv"
    if f.exists() and time.time() - f.stat().st_mtime < 24 * 3600:
        return pd.read_csv(f, index_col=0, parse_dates=True)
    import yfinance as yf
    for attempt in range(3):
        try:
            raw = yf.download(ticker, period=PERIOD[interval], interval=interval, auto_adjust=True, progress=False, threads=False)
            if raw is None or raw.empty:
                time.sleep(1.5)
                continue
            if isinstance(raw.columns, pd.MultiIndex):
                raw.columns = raw.columns.get_level_values(0)
            df = raw.rename(columns=str.lower)[["open", "high", "low", "close", "volume"]].dropna()
            df.index = pd.to_datetime(df.index, utc=True)
            df.index.name = "time"
            cache.mkdir(parents=True, exist_ok=True)
            df.to_csv(f)
            return df
        except Exception as e:  # Netzwerk/Ratenlimit: erneut versuchen
            print(f"  {ticker}: {e}", file=sys.stderr)
            time.sleep(2 * (attempt + 1))
    return None


def demo_data(seed: int, n: int) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    close = 100 * np.exp(np.cumsum(rng.normal(0.0002, 0.012, n)) + 0.3 * np.sin(np.arange(n) / 40) * 0.05)
    open_ = np.r_[close[0], close[:-1]]
    high = np.maximum(open_, close) * (1 + np.abs(rng.normal(0, 0.004, n)))
    low = np.minimum(open_, close) * (1 - np.abs(rng.normal(0, 0.004, n)))
    idx = pd.date_range("2016-01-01", periods=n, freq="D", tz="UTC")
    return pd.DataFrame({"open": open_, "high": high, "low": low, "close": close, "volume": 1.0}, index=idx)


def stats_from_equity(eq: pd.Series, bars_per_year: float) -> dict[str, float]:
    eq = eq.iloc[WARMUP:]
    r = eq.pct_change().dropna()
    sd = r.std(ddof=0)
    half = len(eq) // 2
    return {
        "sharpe": float(r.mean() / sd * np.sqrt(bars_per_year)) if sd > 0 else 0.0,
        "ret_h1": float((eq.iloc[half] / eq.iloc[0] - 1) * 100),
        "ret_h2": float((eq.iloc[-1] / eq.iloc[half] - 1) * 100),
    }


def run_market(args: tuple) -> list[dict]:
    """Alle Strategien auf einem Markt (läuft in einem eigenen Prozess)."""
    cls, name, df, interval, cfg_path = args
    cfg = load_config(cfg_path)
    fee, slip = COSTS[cls]
    cfg = dataclasses.replace(cfg, market=dataclasses.replace(cfg.market, timeframe=interval),
                              costs=dataclasses.replace(cfg.costs, fee_pct=fee, slippage_pct=slip))
    years = max((df.index[-1] - df.index[0]).days / 365.25, 0.1)
    bpy = len(df) / years
    bh = float((df["close"].iloc[-1] / df["close"].iloc[WARMUP] - 1) * 100)
    bt = Backtester(cfg)
    rows = []
    for type_name, params in DEFAULT_SPECS:
        strat = build_strategy({"type": type_name, "params": params})
        try:
            res = bt.run(df, strat, symbol=name)
        except Exception as e:  # einzelne Strategie scheitert -> Markt läuft weiter
            print(f"  {name} {strat.name}: {e}", file=sys.stderr)
            continue
        m = res.metrics
        rows.append({"klasse": cls, "markt": name, "strategie": strat.name, "typ": type_name, "kerzen": len(df), "jahre": round(years, 1),
                     "rendite_pct": m["return_pct"], "buyhold_pct": bh, "maxdd_pct": m["max_drawdown_pct"], "trefferquote_pct": m["win_rate_pct"],
                     "profitfaktor": m["profit_factor"], "trades": m["trades"], "oos_rendite_pct": m["oos_return_pct"],
                     **stats_from_equity(res.equity, bpy)})
    return rows


def summarize(df: pd.DataFrame, min_trades: int) -> pd.DataFrame:
    d = df[df.trades >= min_trades].copy()  # Ergebnisse mit sehr wenigen Trades zählen nicht (Zufall)
    d["gewinn"] = d.rendite_pct > 0
    d["beide_haelften"] = (d.ret_h1 > 0) & (d.ret_h2 > 0)
    d["schlaegt_bh"] = d.rendite_pct > d.buyhold_pct
    g = d.groupby("strategie")
    out = pd.DataFrame({
        "maerkte": g.size(), "pct_im_plus": g.gewinn.mean() * 100, "pct_beide_haelften_plus": g.beide_haelften.mean() * 100,
        "pct_schlaegt_buyhold": g.schlaegt_bh.mean() * 100, "median_sharpe": g.sharpe.median(), "median_rendite": g.rendite_pct.median(),
        "median_trefferquote": g.trefferquote_pct.median(), "median_profitfaktor": g.profitfaktor.median(),
        "median_maxdd": g.maxdd_pct.median(), "median_trades": g.trades.median(), "median_oos": g.oos_rendite_pct.median(),
    })
    # Rangzahl: Beständigkeit (beide Hälften im Plus) zählt am meisten, dann Sharpe; kleine Marktzahl wird nicht belohnt
    out["punkte"] = out.pct_beide_haelften_plus * 0.5 + out.pct_im_plus * 0.2 + out.median_sharpe.clip(-1, 2) * 15 + out.median_profitfaktor.clip(0, 2) * 5
    return out.sort_values("punkte", ascending=False)


def report(df: pd.DataFrame, summ: pd.DataFrame, interval: str, min_trades: int) -> str:
    L = [f"MASSEN-TEST  Zeitrahmen {interval}  |  {df.markt.nunique()} Märkte, {df.strategie.nunique()} Strategie-Varianten, {len(df)} Läufe",
         f"Nur Läufe mit >= {min_trades} Trades. Long-only (Kaufen/Verkaufen), Gebühren+Slippage je Klasse eingerechnet, Stop/Ziel nach den Bot-Regeln.",
         "Spalten: im+ = % Märkte mit Gewinn | beide = % Märkte mit Gewinn in BEIDEN Zeithälften | >B&H = % Märkte besser als Kaufen-und-Halten", ""]
    L.append(f"{'Strategie':<62}{'Mkt':>4}{'im+':>5}{'beide':>6}{'>B&H':>5}{'Sharpe':>7}{'Rend%':>7}{'Treff%':>7}{'PF':>5}{'DD%':>6}{'Trd':>5}")
    for name, r in summ.iterrows():
        L.append(f"{name[:61]:<62}{int(r.maerkte):>4}{r.pct_im_plus:>5.0f}{r.pct_beide_haelften_plus:>6.0f}{r.pct_schlaegt_buyhold:>5.0f}{r.median_sharpe:>7.2f}"
                 f"{r.median_rendite:>7.1f}{r.median_trefferquote:>7.1f}{r.median_profitfaktor:>5.2f}{r.median_maxdd:>6.1f}{r.median_trades:>5.0f}")
    L += ["", "TOP 8 JE MARKTKLASSE (Median-Rendite % der Variante in dieser Klasse, mind. 3 Märkte mit genug Trades)"]
    d = df[df.trades >= min_trades]
    for cls, sub in d.groupby("klasse"):
        agg = sub.groupby("strategie").agg(n=("markt", "size"), rend=("rendite_pct", "median"), sharpe=("sharpe", "median"), plus=("rendite_pct", lambda x: (x > 0).mean() * 100))
        agg = agg[agg.n >= 3].sort_values("sharpe", ascending=False).head(8)
        L.append(f"\n[{cls}] ({sub.markt.nunique()} Märkte, Buy&Hold-Median {sub.drop_duplicates('markt').buyhold_pct.median():.0f} %)")
        for name, r in agg.iterrows():
            L.append(f"  {name[:60]:<60} Sharpe {r.sharpe:>5.2f}  Rend {r.rend:>6.1f}%  im Plus {r.plus:>3.0f}% ({int(r.n)} Märkte)")
    L += ["", "BESTE EINZELLÄUFE nach Sharpe (Vorsicht: bei so vielen Tests sind einzelne Spitzenwerte Zufall)"]
    for _, r in d.sort_values("sharpe", ascending=False).head(15).iterrows():
        L.append(f"  {r.markt:<12}{r.strategie[:55]:<56} Sharpe {r.sharpe:>5.2f}  Rend {r.rendite_pct:>7.1f}%  B&H {r.buyhold_pct:>7.1f}%  Treff {r.trefferquote_pct:>4.0f}%  {int(r.trades)} Trades")
    L += ["", "Märkte ohne Daten / ausgelassen: siehe fehlend.txt"]
    return "\n".join(L)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--interval", choices=list(PERIOD), default="1d")
    ap.add_argument("--workers", type=int, default=0, help="parallele Prozesse (0 = automatisch)")
    ap.add_argument("--min-trades", type=int, default=0, help="Mindestzahl Trades je Lauf (0 = automatisch nach Zeitrahmen)")
    ap.add_argument("--config", default=str(ROOT / "config.yaml"))
    ap.add_argument("--demo", action="store_true", help="Zufallsdaten statt Download (nur Funktionstest, Ergebnisse bedeutungslos)")
    ap.add_argument("--limit", type=int, default=0, help="nur die ersten N Märkte (Test)")
    a = ap.parse_args()
    out = Path(__file__).parent / "out" / (("demo_" if a.demo else "") + a.interval)
    out.mkdir(parents=True, exist_ok=True)
    cache = Path(__file__).parent / "cache"
    min_trades = a.min_trades or {"1d": 15, "1h": 30, "1wk": 8}[a.interval]

    jobs, missing = [], []
    items = [(c, n, t) for c, m in UNIVERSE.items() for n, t in m.items()]
    if a.limit:
        items = items[: a.limit]
    for i, (cls, name, ticker) in enumerate(items, 1):
        print(f"[{i}/{len(items)}] Daten {name} ({ticker}) …", flush=True)
        df = demo_data(i, 2500 if a.interval == "1d" else 8000) if a.demo else download(ticker, a.interval, cache)
        if df is None or len(df) < WARMUP + 200:
            missing.append(f"{name} ({ticker}): {'keine Daten' if df is None else f'nur {len(df)} Kerzen'}")
            continue
        jobs.append((cls, name, df, a.interval, a.config))
    (out / "fehlend.txt").write_text("\n".join(missing) or "alle Märkte geladen", encoding="utf-8")
    if not jobs:
        print("Keine Daten geladen – Internetverbindung / yfinance prüfen (pip install yfinance).")
        return 1
    print(f"\nTeste {len(DEFAULT_SPECS)} Strategie-Varianten auf {len(jobs)} Märkten …", flush=True)
    rows, t0 = [], time.time()
    with ProcessPoolExecutor(max_workers=a.workers or None) as ex:
        for k, res in enumerate(ex.map(run_market, jobs), 1):
            rows += res
            print(f"  {k}/{len(jobs)} Märkte fertig ({time.time() - t0:.0f}s)", flush=True)
    df = pd.DataFrame(rows)
    df.to_csv(out / "alle_laeufe.csv", index=False, float_format="%.4f")
    summ = summarize(df, min_trades)
    summ.to_csv(out / "je_strategie.csv", float_format="%.3f")
    txt = report(df, summ, a.interval, min_trades)
    (out / "ergebnisse.txt").write_text(txt, encoding="utf-8")
    print("\n" + txt[:3500] + "\n…\n")
    print(f"FERTIG. Schick mir diese Datei: {out / 'ergebnisse.txt'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
