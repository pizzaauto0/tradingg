import pandas as pd

from conftest import make_ohlcv
from tradingbot.backtest import Backtester, check_thresholds
from tradingbot.strategies import Strategy, build_strategy


class EveryNth(Strategy):
    """Test-Strategie: Einstieg alle 40 Kerzen, Ausstieg 10 Kerzen später."""
    type_name = "every_nth"
    default_regimes = ("uptrend", "downtrend", "sideways")
    param_spec = {"n": (int, 1, 1000)}

    def entry(self, df):
        return pd.Series([i % 40 == 0 for i in range(len(df))], index=df.index)

    def exit(self, df):
        return pd.Series([i % 40 == 10 for i in range(len(df))], index=df.index)

    def explain(self, df):
        return "test"


def test_costs_reduce_return(cfg):
    df = make_ohlcv(800, seed=2)
    strat = EveryNth(n=1)
    free = Backtester(cfg)
    cfg.costs.fee_pct = cfg.costs.slippage_pct = 0.0
    r0 = free.run(df, strat).metrics["return_pct"]
    cfg.costs.fee_pct, cfg.costs.slippage_pct = 0.26, 0.05
    r1 = Backtester(cfg).run(df, strat).metrics["return_pct"]
    assert r1 < r0


def test_entry_executes_on_next_open_not_signal_bar(cfg):
    cfg.costs.fee_pct = cfg.costs.slippage_pct = 0.0
    df = make_ohlcv(400, seed=4)
    res = Backtester(cfg).run(df, EveryNth(n=1))
    assert res.trades
    for t in res.trades:
        i = df.index.get_loc(t.entry_time)
        assert i % 40 == 1                       # Signal bei i-1, Ausführung bei i
        assert t.entry_price == df["open"].iloc[i]


def test_loss_per_trade_bounded_by_risk(cfg):
    cfg.costs.fee_pct = cfg.costs.slippage_pct = 0.0
    df = make_ohlcv(1500, vol=0.004, seed=7)
    res = Backtester(cfg).run(df, EveryNth(n=1))
    worst = min(t.pnl for t in res.trades)
    # Stop-Loss begrenzt Verlust auf ~1 % des Kapitals (Gap-Overshoot ausgenommen: Toleranz 1.5 %)
    assert worst > -cfg.capital.start * 0.015


def test_metrics_and_thresholds(cfg):
    df = make_ohlcv(1200, drift=0.0005, seed=9)
    res = Backtester(cfg).run(df, build_strategy({"type": "ma_crossover", "params": {"fast": 9, "slow": 21}}))
    for key in ("return_pct", "max_drawdown_pct", "sharpe", "win_rate_pct", "trades"):
        assert key in res.metrics
    assert 0 <= res.metrics["win_rate_pct"] <= 100 and res.metrics["max_drawdown_pct"] >= 0
    ok, fails = check_thresholds({**res.metrics, "trades": 0.0}, cfg.backtest)
    assert not ok and any("Trades" in f for f in fails)
