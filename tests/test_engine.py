from datetime import timedelta

import pandas as pd
import pytest

from conftest import make_ohlcv
from tradingbot.engine import TradingEngine
from tradingbot.execution import LiveBroker, PaperBroker, StopPlacementError
from tradingbot.notify import Notifier
from tradingbot.strategies import STRATEGY_TYPES, Strategy
from tradingbot.tradelog import TradeLog


class AlwaysLong(Strategy):
    type_name = "always_long"
    default_regimes = ("uptrend", "downtrend", "sideways")
    param_spec = {"x": (int, 0, 10)}

    def entry(self, df):
        return pd.Series(True, index=df.index)

    def exit(self, df):
        return pd.Series(False, index=df.index)

    def explain(self, df):
        return "immer"


class StubData:
    def __init__(self, frame):
        self.frame, self.upto = frame, 300

    def fetch_recent(self, symbol, limit=None):
        return self.frame.iloc[:self.upto]

    def fetch_price(self, symbol):
        return float(self.frame["close"].iloc[self.upto - 1])

    def normalize_amount(self, symbol, amount, price):
        return round(amount, 6)

    def now(self):  # Zeit direkt nach Schluss der letzten Kerze
        return self.frame.index[self.upto - 1] + timedelta(minutes=15, seconds=5)


@pytest.fixture
def setup(cfg, monkeypatch):
    monkeypatch.setitem(STRATEGY_TYPES, "always_long", AlwaysLong)
    frame = make_ohlcv(400, drift=0.0003, vol=0.002, seed=11).copy()
    data = StubData(frame)
    state = {}
    approved = [{"symbol": "BTC/USD", "timeframe": "15m", "metrics": {"sharpe": 2.0},
                 "spec": {"type": "always_long", "params": {"x": 1}}}]
    engine = TradingEngine(cfg, data, PaperBroker(cfg, state), TradeLog(cfg.data_dir), Notifier(cfg), state,
                           cfg.data_dir / "state.json", approved)
    return cfg, frame, data, engine


def test_entry_with_stop_and_logged_reason(setup):
    cfg, frame, data, engine = setup
    engine.tick(data.now())                      # erstes Sehen: keine Aktion
    assert not engine.positions
    data.upto = 301
    engine.tick(data.now())
    pos = engine.positions["BTC/USD"]
    assert 0 < pos.stop < pos.entry_price < pos.take_profit
    loss_at_stop = pos.amount * (pos.entry_price - pos.stop)
    assert loss_at_stop <= cfg.capital.start * cfg.risk.risk_per_trade_pct / 100 + 1e-6
    entry = engine.tradelog.recent(1)[0]
    assert entry["action"] == "ENTRY" and "Stop" in entry["reason"] and entry["mode"] == "paper"


def test_stop_loss_exit(setup):
    cfg, frame, data, engine = setup
    engine.tick(data.now())
    data.upto = 301
    engine.tick(data.now())
    pos = engine.positions["BTC/USD"]
    crash = frame.copy()
    crash.iloc[302, crash.columns.get_loc("low")] = pos.stop * 0.99
    crash.iloc[302, crash.columns.get_loc("close")] = pos.stop * 0.995
    data.frame, data.upto = crash, 303
    engine.tick(data.now())
    assert "BTC/USD" not in engine.positions        # kein Wiedereinstieg im selben Durchlauf
    last = engine.tradelog.recent(1)[0]
    assert last["action"] == "EXIT" and last["pnl"] < 0 and "Stop-Loss" in last["reason"]
    assert abs(last["pnl"]) <= cfg.capital.start * 0.015


def test_daily_loss_limit_halts_and_flattens(setup):
    cfg, frame, data, engine = setup
    cfg.risk.max_daily_loss_pct = 0.3
    cfg.risk.max_position_pct = 100
    engine.tick(data.now())
    data.upto = 301
    engine.tick(data.now())
    pos = engine.positions["BTC/USD"]
    drop = frame.copy()
    price = pos.entry_price * 0.997               # Kurs fällt, bleibt aber über dem Stop
    drop.iloc[301:, drop.columns.get_loc("close")] = price
    drop.iloc[301:, drop.columns.get_loc("low")] = price
    drop.iloc[301:, drop.columns.get_loc("open")] = price
    drop.iloc[301:, drop.columns.get_loc("high")] = price
    pos.stop = price * 0.5
    data.frame, data.upto = drop, 303
    engine.tick(data.now())
    assert engine.risk.halted and not engine.positions
    data.upto = 304
    engine.tick(data.now())
    assert not engine.positions                   # kein neuer Einstieg nach Limit


def test_max_open_positions(setup):
    cfg, frame, data, engine = setup
    cfg.market.symbols = ["BTC/USD", "ETH/USD"]
    cfg.risk.max_open_positions = 1
    engine.approved.append({**engine.approved[0], "symbol": "ETH/USD"})
    data.fetch_recent = lambda s, limit=None: data.frame.iloc[:data.upto]
    engine.tick(data.now())
    data.upto = 301
    engine.tick(data.now())
    assert len(engine.positions) == 1


def test_kill_switch_closes_everything_and_stops(setup):
    cfg, frame, data, engine = setup
    engine.tick(data.now())
    data.upto = 301
    engine.tick(data.now())
    assert engine.positions
    engine.risk.kill_switch_path.write_text("x")
    engine.tick(data.now())
    assert not engine.positions and engine.stop_requested
    assert engine.tradelog.recent(1)[0]["reason"] == "Kill Switch"


def test_restart_restores_positions(setup):
    cfg, frame, data, engine = setup
    engine.tick(data.now())
    data.upto = 301
    engine.tick(data.now())
    from tradingbot.engine import load_state
    state = load_state(cfg.data_dir / "state.json")
    engine2 = TradingEngine(cfg, data, PaperBroker(cfg, state), TradeLog(cfg.data_dir), Notifier(cfg), state,
                            cfg.data_dir / "state.json", engine.approved)
    assert set(engine2.positions) == {"BTC/USD"}
    assert engine2.broker.cash() == pytest.approx(engine.broker.cash())


class FakeEx:
    """Börse, bei der die Stop-Order abgelehnt wird."""
    def __init__(self):
        self.orders = []

    def load_markets(self): pass
    def fetch_balance(self): return {"free": {"USD": 1000, "BTC": 1}, "total": {"BTC": 1}}
    def amount_to_precision(self, s, a): return str(a)
    def price_to_precision(self, s, p): return str(p)
    def cancel_order(self, *a): pass

    def create_order(self, symbol, typ, side, amount, price=None, params=None):
        self.orders.append((typ, side, params))
        if params and "stopLossPrice" in params:
            raise RuntimeError("stop rejected")
        return {"id": f"o{len(self.orders)}"}

    def fetch_order(self, oid, symbol):
        return {"status": "closed", "filled": 0.01, "average": 100.0, "fee": None}


def test_live_closes_position_if_stop_cannot_be_placed(cfg):
    broker = LiveBroker(cfg, exchange=FakeEx())
    with pytest.raises(StopPlacementError):
        broker.open_long("BTC/USD", 0.01, 95.0, 100.0)
    assert [o[1] for o in broker.ex.orders] == ["buy", "sell", "sell"]  # kaufen, Stop scheitert, Notverkauf
    assert broker.ex.orders[-1][2] is None
