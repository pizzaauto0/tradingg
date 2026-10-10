import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tradingbot.config import Config  # noqa: E402


def make_ohlcv(n=600, drift=0.0, vol=0.002, seed=1, start="2025-01-01", tf="15min", price=100.0):
    rng = np.random.default_rng(seed)
    rets = rng.normal(drift, vol, n)
    close = price * np.exp(np.cumsum(rets))
    open_ = np.concatenate([[price], close[:-1]])
    spread = np.abs(rng.normal(0, vol / 2, n)) * close
    high = np.maximum(open_, close) + spread
    low = np.minimum(open_, close) - spread
    volume = rng.uniform(50, 150, n)
    idx = pd.date_range(start, periods=n, freq=tf, tz="UTC", name="time")
    return pd.DataFrame({"open": open_, "high": high, "low": low, "close": close, "volume": volume}, index=idx)


@pytest.fixture
def cfg(tmp_path):
    c = Config()
    c.paths.data_dir = str(tmp_path / "data")
    c.risk.kill_switch_file = str(tmp_path / "KILL")
    c.market.symbols = ["BTC/USD"]
    return c.validate()
