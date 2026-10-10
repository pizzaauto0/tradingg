from datetime import timedelta

import numpy as np
import pandas as pd
import pytest

from conftest import make_ohlcv
from tradingbot.backtest import Backtester
from tradingbot.config import Config, ConfigError
from tradingbot.engine import TradingEngine
from tradingbot.execution import PaperMarginBroker, Position
from tradingbot.ibkr import IBKRBroker, round_price
from tradingbot.notify import Notifier
from tradingbot.pipeline import mark_active
from tradingbot.strategies import STRATEGY_TYPES, Strategy, build_strategy, default_candidates
from tradingbot.tradelog import TradeLog


def mixed_market(n=3000, seed=8):
    """Aufwärts-, Seitwärts- und Abwärtsphasen mit wechselnder Volatilität."""
    parts = [make_ohlcv(n // 3, drift=d, vol=v, seed=seed + i, price=100.0) for i, (d, v) in
             enumerate([(0.0006, 0.003), (0.0, 0.004), (-0.0006, 0.003)])]
    out, last = [], 100.0
    for p in parts:
        k = last / p["open"].iloc[0]
        out.append(p * [k, k, k, k, 1])
        last = float(out[-1]["close"].iloc[-1])
    df = pd.concat(out)
    df.index = pd.date_range("2025-01-01", periods=len(df), freq="15min", tz="UTC", name="time")
    return df


def margin_cfg(tmp_path, short=True):
    c = Config(broker="ibkr")
    c.market.symbols = ["EUR/USD"]
    c.market.allow_short = short
    c.risk.max_position_pct = 500
    c.costs.fee_pct, c.costs.slippage_pct = 0.002, 0.005
    c.paths.data_dir = str(tmp_path / "data")
    c.risk.kill_switch_file = str(tmp_path / "KILL")
    return c.validate()


# --------------------------------------------------------------------------- Strategien
def test_library_has_25_types_and_30_plus_candidates():
    assert len(STRATEGY_TYPES) >= 25
    cands = default_candidates()
    assert len(cands) >= 30
    for spec in cands:
        build_strategy(spec)
    assert {s["type"] for s in cands} == set(STRATEGY_TYPES), "jeder Typ hat mindestens einen Kandidaten"


@pytest.mark.parametrize("spec", default_candidates(), ids=lambda s: s["type"])
def test_every_candidate_produces_signals_and_is_causal(spec):
    df = mixed_market()
    s = build_strategy(spec)
    entry, exit_ = s.entry(df), s.exit(df)
    assert entry.dtype == bool and exit_.dtype == bool and len(entry) == len(df)
    assert entry.sum() > 0, f"{s.name} erzeugt nie ein Signal"
    cut = s.entry(df.iloc[:2000])
    assert (entry.iloc[:2000].to_numpy() == cut.to_numpy()).all(), f"{s.name} schaut in die Zukunft"


def test_exit_overrides_are_validated_and_change_win_rate(cfg):
    cfg.costs.fee_pct = cfg.costs.slippage_pct = 0.0  # ohne Kosten; mit hohen Gebühren werden nahe Ziele zu Verlusten
    with pytest.raises(ValueError):
        build_strategy({"type": "rsi_reversion", "params": {"period": 14, "oversold": 30, "exit_level": 55, "rr": 9}})
    df = mixed_market()
    near = build_strategy({"type": "breakout", "params": {"lookback": 20, "exit_lookback": 20, "rr": 0.5}})
    far = build_strategy({"type": "breakout", "params": {"lookback": 20, "exit_lookback": 20, "rr": 4.0}})
    assert "rr=0.5" in near.name and near.to_spec()["params"]["rr"] == 0.5
    wr_near = Backtester(cfg).run(df, near).metrics["win_rate_pct"]
    wr_far = Backtester(cfg).run(df, far).metrics["win_rate_pct"]
    assert wr_near > wr_far, "nahes Ziel muss eine höhere Trefferquote ergeben"


# ------------------------------------------------------------------- Short / Margin
def test_short_trades_only_in_margin_mode_and_pnl_is_correct(tmp_path, cfg):
    df = mixed_market()
    strat = build_strategy({"type": "ma_crossover", "params": {"fast": 9, "slow": 21}, "regimes": ["uptrend", "downtrend", "sideways"]})
    spot = Backtester(cfg).run(df, strat)
    assert all(t.side == 1 for t in spot.trades)
    mcfg = margin_cfg(tmp_path)
    mcfg.costs.fee_pct = mcfg.costs.slippage_pct = 0.0
    res = Backtester(mcfg).run(df, strat)
    shorts = [t for t in res.trades if t.side == -1]
    assert shorts and any(t.side == 1 for t in res.trades)
    for t in res.trades:  # ohne Kosten: PnL = Richtung * Menge * Kursdifferenz
        assert t.pnl == pytest.approx(t.side * t.amount * (t.exit_price - t.entry_price))
    worst = min(t.pnl for t in res.trades)
    assert worst > -mcfg.capital.start * 0.015, "Stop begrenzt auch Short-Verluste auf ca. 1 %"


def test_mark_active_picks_best_five_unique():
    def rec(sym, typ, sharpe, wr=60):
        return {"symbol": sym, "spec": {"type": typ}, "name": f"{typ}-{sharpe}", "metrics": {"sharpe": sharpe, "win_rate_pct": wr}}
    approved = [rec("A", "x", 5), rec("A", "x", 4.9), rec("A", "y", 3), rec("B", "x", 2.5), rec("B", "z", 2),
                rec("C", "w", 1.5), rec("C", "v", 1.0)]
    mark_active(approved, 5)
    active = [a["name"] for a in approved if a["active"]]
    assert active == ["x-5", "y-3", "x-2.5", "z-2", "w-1.5"]
    assert not next(a for a in approved if a["name"] == "x-4.9")["active"], "zweite Variante desselben Typs/Markts bleibt Reserve"


def test_selector_ignores_reserve_strategies():
    from tradingbot.analysis import classify_market
    from tradingbot.selector import select_strategy
    state = classify_market(make_ohlcv(400, drift=0.002, vol=0.001))
    base = {"symbol": "BTC/USD", "timeframe": "15m", "metrics": {"sharpe": 9},
            "spec": {"type": "ma_crossover", "params": {"fast": 9, "slow": 21}}}
    assert select_strategy([{**base, "active": False}], "BTC/USD", "15m", state) is None
    assert select_strategy([{**base, "active": True}], "BTC/USD", "15m", state) is not None


# ----------------------------------------------------------------- Engine mit Short
class Rising(Strategy):
    type_name = "test_rising"
    default_regimes = ("uptrend", "downtrend", "sideways")
    param_spec = {"x": (int, 0, 1)}

    def entry(self, df):
        return df["close"] > df["close"].shift(1)

    def exit(self, df):
        return pd.Series(False, index=df.index)


class Stub:
    def __init__(self, frame):
        self.frame, self.upto = frame, 300

    def fetch_recent(self, symbol, limit=None):
        return self.frame.iloc[:self.upto]

    def fetch_price(self, symbol):
        return float(self.frame["close"].iloc[self.upto - 1])

    def normalize_amount(self, symbol, amount, price):
        return float(int(amount))

    def now(self):
        return self.frame.index[self.upto - 1] + timedelta(minutes=15, seconds=5)


def test_paper_forex_opens_short_on_falling_candle_and_stops_out(tmp_path, monkeypatch):
    monkeypatch.setitem(STRATEGY_TYPES, "test_rising", Rising)
    cfg = margin_cfg(tmp_path)
    frame = make_ohlcv(400, drift=0.0, vol=0.0005, seed=3, price=1.1).copy()
    frame.iloc[300, frame.columns.get_loc("close")] = frame["close"].iloc[299] * 0.999   # fallende Kerze
    frame.iloc[300, frame.columns.get_loc("low")] = min(frame["low"].iloc[300], frame["close"].iloc[300])
    data, state = Stub(frame), {}
    approved = [{"symbol": "EUR/USD", "timeframe": "15m", "metrics": {"sharpe": 2, "win_rate_pct": 60},
                 "spec": {"type": "test_rising", "params": {"x": 0}}, "active": True}]
    eng = TradingEngine(cfg, data, PaperMarginBroker(cfg, state), TradeLog(cfg.data_dir), Notifier(cfg), state,
                        cfg.data_dir / "s.json", approved)
    eng.tick(data.now())
    data.upto = 301
    eng.tick(data.now())
    pos = eng.positions["EUR/USD"]
    assert pos.side == -1 and pos.stop > pos.entry_price > pos.take_profit
    assert pos.amount * abs(pos.entry_price - pos.stop) <= cfg.capital.start * 0.01 * 1.001
    assert pos.amount * pos.entry_price <= cfg.capital.start * 5 * 1.01, "Hebelgrenze 1:5"
    assert eng.tradelog.recent(1)[0]["reason"].startswith("SHORT")
    from tradingbot.analysis import classify_market
    assert pos.regime == classify_market(frame.iloc[:300]).regime, "Marktphase wird aus Sicht des Originalkurses gespeichert"

    spike = frame.copy()                                           # Kurs springt über den Short-Stop
    spike.iloc[301, spike.columns.get_loc("high")] = pos.stop * 1.001
    spike.iloc[301, spike.columns.get_loc("close")] = pos.stop * 1.0005
    data.frame, data.upto = spike, 302
    eng.tick(data.now())
    assert "EUR/USD" not in eng.positions
    exit_row = eng.tradelog.recent(1)[0]
    assert exit_row["action"] == "EXIT" and exit_row["pnl"] < 0
    assert abs(exit_row["pnl"]) <= cfg.capital.start * 0.015
    assert eng.equity() == pytest.approx(state["paper"]["cash"])


# ------------------------------------------------------------------------ IBKR
class FakeStatus:
    def __init__(self):
        self.status, self.avgFillPrice, self.filled = "Submitted", 0.0, 0.0


class FakeTrade:
    def __init__(self, order):
        self.order, self.orderStatus, self.fills = order, FakeStatus(), []

    def isDone(self):
        return self.orderStatus.status in ("Filled", "Cancelled")


class FakeIB:
    def __init__(self, account="DU123", fill_px=1.1):
        self.account, self.fill_px, self.placed, self._trades, self._pos = account, fill_px, [], [], {}
        self._id = 100
        self.client = self

    def getReqId(self):
        self._id += 1
        return self._id

    def managedAccounts(self):
        return [self.account]

    def accountSummary(self, account):
        class V:
            tag, value, currency = "NetLiquidation", "10000", "EUR"
        return [V()]

    def placeOrder(self, contract, order):
        t = FakeTrade(order)
        self.placed.append(order)
        self._trades.append(t)
        if order.orderType == "MKT":
            t.orderStatus.status, t.orderStatus.avgFillPrice, t.orderStatus.filled = "Filled", self.fill_px, order.totalQuantity
            self._pos["EURUSD"] = self._pos.get("EURUSD", 0) + (order.totalQuantity if order.action == "BUY" else -order.totalQuantity)
        return t

    def trades(self):
        return self._trades

    def positions(self, account):
        class P:
            def __init__(self, q):
                self.position = q
                self.contract = type("C", (), {"symbol": "EUR", "currency": "USD"})()
        return [P(q) for q in self._pos.values() if q]

    def reqAllOpenOrders(self):
        self.open_orders_requested = True
        return []

    def cancelOrder(self, order):
        for t in self._trades:
            if t.order is order:
                t.orderStatus.status = "Cancelled"

    def sleep(self, s):
        pass


class FakeData:
    def contract(self, symbol):
        return object()

    def fetch_price(self, symbol):
        if symbol == "EUR/USD":
            return 1.1
        raise RuntimeError("kein Paar")


def test_ibkr_bracket_order_with_broker_side_stop_and_target(tmp_path):
    cfg = margin_cfg(tmp_path)
    ib = FakeIB()
    br = IBKRBroker(cfg, ib, FakeData())
    fill = br.open_position("EUR/USD", -1, 12345.9, stop=1.10234, take_profit=1.09611, ref_price=1.1)
    parent, tp, sl = ib.placed
    assert (parent.action, parent.orderType, parent.totalQuantity, parent.transmit) == ("SELL", "MKT", 12345, False)
    assert (tp.action, tp.orderType, tp.lmtPrice, tp.parentId, tp.transmit) == ("BUY", "LMT", 1.0961, parent.orderId, False)
    assert (sl.action, sl.orderType, sl.auxPrice, sl.parentId, sl.transmit) == ("BUY", "STP", 1.10235, parent.orderId, True)
    assert tp.ocaGroup == sl.ocaGroup != "" and tp.tif == sl.tif == "GTC"
    assert fill.amount == 12345 and fill.stop_order_id == str(sl.orderId) and fill.tp_order_id == str(tp.orderId)

    pos = Position("EUR/USD", fill.amount, fill.price, 1.10235, 1.0961, 0, "2025-01-01T00:00:00+00:00",
                   side=-1, stop_order_id=fill.stop_order_id, tp_order_id=fill.tp_order_id)
    assert br.check_stop(pos, 1.101, 1.1) is None
    tp_trade = ib._trades[1]
    tp_trade.orderStatus.status, tp_trade.orderStatus.avgFillPrice, tp_trade.orderStatus.filled = "Filled", 1.0961, 12345
    out = br.check_stop(pos, 1.101, 1.096)
    assert out.price == 1.0961 and "Take-Profit" in out.reason
    assert br.manages_take_profit


def test_ibkr_refuses_real_account_in_paper_mode_and_converts_currency(tmp_path):
    cfg = margin_cfg(tmp_path)
    with pytest.raises(ConfigError, match="kein Paper-Konto"):
        IBKRBroker(cfg, FakeIB(account="U7654321"), FakeData())
    br = IBKRBroker(cfg, FakeIB(), FakeData())
    assert br.account_ccy == "EUR"
    assert br.to_quote("EUR/USD", 1000) == pytest.approx(1100)    # 1000 EUR = 1100 USD bei 1,10


def test_price_rounding_to_ib_ticks():
    assert round_price("EUR/USD", 1.123456) == 1.12345
    assert round_price("EUR/USD", 1.123476) == 1.1235
    assert round_price("USD/JPY", 151.2371) == 151.235


def test_config_rules_for_forex(tmp_path):
    with pytest.raises(ConfigError, match="allow_short"):
        c = Config(); c.market.allow_short = True; c.validate()
    with pytest.raises(ConfigError, match="max_position_pct"):
        c = Config(); c.risk.max_position_pct = 500; c.validate()
    margin_cfg(tmp_path)  # 500 % ist mit ibkr erlaubt
    with pytest.raises(ConfigError, match="Währungspaare"):
        c = Config(broker="ibkr"); c.market.symbols = ["BTC/USDT"]; c.validate()


def test_tight_target_with_high_fees_turns_hits_into_losses(cfg):
    """Warum Trefferquote allein täuscht: bei Krypto-Gebühren (~0,6 % pro Runde) sind sehr nahe Ziele Verlustbringer."""
    df = mixed_market()
    near = build_strategy({"type": "breakout", "params": {"lookback": 20, "exit_lookback": 20, "rr": 0.5}})
    res = Backtester(cfg).run(df, near)
    tp_trades = [t for t in res.trades if t.exit_reason == "take_profit"]
    assert tp_trades and sum(t.pnl < 0 for t in tp_trades) > len(tp_trades) / 2


def test_ibkr_rechecks_open_orders_before_declaring_stop_lost(tmp_path):
    cfg = margin_cfg(tmp_path)
    ib = FakeIB()
    br = IBKRBroker(cfg, ib, FakeData())
    fill = br.open_position("EUR/USD", 1, 20000, stop=1.09, take_profit=1.12, ref_price=1.1)
    pos = Position("EUR/USD", fill.amount, fill.price, 1.09, 1.12, 0, "2025-01-01T00:00:00+00:00",
                   stop_order_id=fill.stop_order_id, tp_order_id=fill.tp_order_id)
    br.check_stop(pos, 1.099, 1.1)
    assert not getattr(ib, "open_orders_requested", False), "bekannte Orders: keine Nachfrage nötig"
    ib._trades = ib._trades[:1]                       # Neustart: Kind-Orders lokal unbekannt
    with pytest.raises(Exception, match="nicht mehr aktiv"):
        br.check_stop(pos, 1.099, 1.1)
    assert ib.open_orders_requested, "vor dem Notfall-Schließen wird beim Broker nachgefragt"
