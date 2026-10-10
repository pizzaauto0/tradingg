import pytest

from conftest import make_ohlcv
from tradingbot.analysis import classify_market, regime_series
from tradingbot.research import parse_proposals
from tradingbot.strategies import build_strategy, default_candidates


def test_regime_detection():
    assert classify_market(make_ohlcv(400, drift=0.002, vol=0.001)).regime == "uptrend"
    assert classify_market(make_ohlcv(400, drift=-0.002, vol=0.001)).regime == "downtrend"
    sideways = regime_series(make_ohlcv(1500, drift=0.0, vol=0.002, seed=3))
    assert (sideways == "sideways").mean() > 0.4


def test_classify_needs_enough_data():
    with pytest.raises(ValueError):
        classify_market(make_ohlcv(50))


def test_default_candidates_are_valid():
    for spec in default_candidates():
        build_strategy(spec)


@pytest.mark.parametrize("spec", [
    {"type": "ma_crossover", "params": {"fast": 30, "slow": 10}},      # fast >= slow
    {"type": "ma_crossover", "params": {"fast": 9}},                   # fehlt slow
    {"type": "rsi_reversion", "params": {"period": 14, "oversold": 5, "exit_level": 55}},  # außerhalb Grenzen
    {"type": "os_system", "params": {}},                               # unbekannter Typ
    {"type": "breakout", "params": {"lookback": 20, "exit_lookback": 10}, "regimes": ["moon"]},
])
def test_invalid_specs_rejected(spec):
    with pytest.raises(ValueError):
        build_strategy(spec)


def test_llm_output_is_validated_and_never_executed():
    text = """Hier sind Vorschläge:
    ```json
    [{"type":"ma_crossover","params":{"fast":10,"slow":30},"regimes":["uptrend"],"rationale":"Trend"},
     {"type":"exec","params":{"code":"import os; os.system('x')"}},
     {"type":"rsi_reversion","params":{"period":14,"oversold":99,"exit_level":55}}]
    ```"""
    out = parse_proposals(text)
    assert [s["type"] for s in out] == ["ma_crossover"] and out[0]["source"] == "llm"
    with pytest.raises(ValueError):
        parse_proposals("keine Liste")


def test_signals_are_causal():
    df = make_ohlcv(400, seed=5)
    for spec in default_candidates():
        s = build_strategy(spec)
        full = s.entry(df)
        cut = s.entry(df.iloc[:300])
        assert (full.iloc[:300] == cut).all(), s.name
