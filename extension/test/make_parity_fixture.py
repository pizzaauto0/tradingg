"""Erzeugt fixtures/parity.json: Testkerzen + erwartete Python-Ergebnisse (Backtest-Kennzahlen, Marktzustand).
Aufruf aus dem Projektroot:  python extension/test/make_parity_fixture.py"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from tradingbot.analysis import classify_market  # noqa: E402
from tradingbot.backtest import Backtester  # noqa: E402
from tradingbot.config import Config  # noqa: E402
from tradingbot.strategies import build_strategy, default_candidates  # noqa: E402


def series(n=2400, seed=5):
    rng = np.random.default_rng(seed)
    drift = np.concatenate([np.full(n // 4, 0.0006), np.zeros(n // 4), np.full(n // 4, -0.0005), np.full(n - 3 * (n // 4), 0.0004)])
    vol = np.where(np.arange(n) % 700 < 100, 0.006, 0.003)
    close = 150 * np.exp(np.cumsum(rng.normal(drift, vol)))
    open_ = np.concatenate([[150.0], close[:-1]])
    spread = np.abs(rng.normal(0, vol / 2)) * close
    idx = pd.date_range("2025-01-01", periods=n, freq="15min", tz="UTC")
    return pd.DataFrame({"open": open_, "high": np.maximum(open_, close) + spread, "low": np.minimum(open_, close) - spread,
                         "close": close, "volume": rng.uniform(50, 150, n)}, index=idx)


cfg = Config()
cfg.capital.start = 300
cfg.costs.fee_pct, cfg.costs.slippage_pct = 0.10, 0.15
df = series()
out = {"candles": {"t": [int(t.timestamp() * 1000) for t in df.index],
                   **{k: [round(float(v), 8) for v in df[k]] for k in ("open", "high", "low", "close", "volume")}},
       "backtests": [], "market": None}
bt = Backtester(cfg)
for spec in default_candidates():
    res = bt.run(df, build_strategy(spec))
    out["backtests"].append({"spec": {k: spec[k] for k in ("type", "params", "regimes")}, "metrics": res.metrics})
s = classify_market(df)
out["market"] = {k: getattr(s, k) for k in ("regime", "volatility", "volume", "adx", "atr_pct", "ema_fast", "ema_slow", "close")}
(Path(__file__).parent / "fixtures").mkdir(exist_ok=True)
(Path(__file__).parent / "fixtures" / "parity.json").write_text(json.dumps(out))
print({b["spec"]["type"] + str(b["spec"]["params"]): round(b["metrics"]["trades"]) for b in out["backtests"]})
