import numpy as np
import pandas as pd
import pytest

from tradingbot.strategies import build_strategy


def frame(close, spread=0.3):
    close = np.asarray(close, float)
    open_ = np.r_[close[0], close[:-1]]
    idx = pd.date_range("2024-01-01", periods=len(close), freq="D", tz="UTC")
    return pd.DataFrame({"open": open_, "high": np.maximum(open_, close) + spread, "low": np.minimum(open_, close) - spread,
                         "close": close, "volume": 1.0}, index=idx)


SPEC = {"type": "ma_pullback", "params": {"ma_period": 50, "slope_bars": 20, "touch_pct": 0.5, "exit_pct": 3.0}}


def test_buys_pullback_to_rising_line_only():
    up = np.linspace(100, 160, 200)
    dip = np.r_[up, np.linspace(160, 150, 6), [155.0]]  # Rücksetzer bis unter die Linie (~153,7), dann grüne Kerze darüber
    s = build_strategy(SPEC)
    sig = s.entry(frame(dip))
    assert sig.iloc[-1], "Kauf nach dem Rücksetzer an der Linie"
    assert not sig.iloc[100:190].any(), "kein Kauf im glatten Anstieg ohne Rücksetzer"


def test_no_buy_when_line_falls():
    down = np.linspace(160, 100, 220)
    bounce = np.r_[down, [108.0]]
    assert not build_strategy(SPEC).entry(frame(bounce)).iloc[-60:].any(), "fallende Linie = Finger weg"


def test_exit_when_trend_breaks_and_param_limits():
    up = np.linspace(100, 160, 200)
    crash = np.r_[up, [140.0]]
    assert build_strategy(SPEC).exit(frame(crash)).iloc[-1]
    with pytest.raises(ValueError):
        build_strategy({"type": "ma_pullback", "params": {"ma_period": 5, "slope_bars": 20, "touch_pct": 0.5, "exit_pct": 3.0}})
