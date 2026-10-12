"""Tests des MT5-Runners mit einer Attrappe des MetaTrader5-Pakets (das echte gibt es nur unter Windows)."""
import types
from collections import namedtuple

import numpy as np
import pandas as pd
import pytest

from mt5bot import config as base_cfg
from mt5bot.runner import Runner
from mt5bot.signals import GoldSilverDivergence, RsiPullback, make_strategy

Pos = namedtuple("Pos", "ticket symbol type volume sl tp magic profit price_open")
Info = namedtuple("Info", "visible volume_step volume_min volume_max trade_stops_level point digits")
Acc = namedtuple("Acc", "login server balance equity currency trade_mode")
Tick = namedtuple("Tick", "ask bid")
Res = namedtuple("Res", "retcode price")


def bars(closes, step_s=4 * 3600, spread=0.3):
    c = np.asarray(closes, float)
    o = np.r_[c[0], c[:-1]]
    t = 1_700_000_000 + np.arange(len(c)) * step_s
    return np.array(list(zip(t, o, np.maximum(o, c) + spread, np.minimum(o, c) - spread, c, np.ones(len(c)))),
                    dtype=[("time", "i8"), ("open", "f8"), ("high", "f8"), ("low", "f8"), ("close", "f8"), ("tick_volume", "f8")])


class FakeMT5:
    TIMEFRAME_M1 = 1; TIMEFRAME_M5 = 5; TIMEFRAME_M15 = 15; TIMEFRAME_M30 = 30; TIMEFRAME_H1 = 16385
    TIMEFRAME_H4 = 16388; TIMEFRAME_D1 = 16408; TIMEFRAME_W1 = 32769
    ACCOUNT_TRADE_MODE_DEMO = 0; ACCOUNT_TRADE_MODE_REAL = 2
    ORDER_TYPE_BUY = 0; ORDER_TYPE_SELL = 1; POSITION_TYPE_BUY = 0; POSITION_TYPE_SELL = 1
    TRADE_ACTION_DEAL = 1; TRADE_ACTION_SLTP = 6; ORDER_TIME_GTC = 0; ORDER_FILLING_IOC = 1; ORDER_FILLING_FOK = 0
    TRADE_RETCODE_DONE = 10009

    def __init__(self, data, mode=0, equity=10_000.0, strip_sl=False, sltp_fails=False):
        self.data, self.mode, self.equity, self.strip_sl, self.sltp_fails = data, mode, equity, strip_sl, sltp_fails
        self.positions, self.sent, self.n = [], [], 0
        self.rows = {}

    def initialize(self, **kw): return True
    def shutdown(self): pass
    def last_error(self): return (0, "ok")
    def account_info(self): return Acc(1, "Demo-Server", self.equity, self.equity, "USD", self.mode)
    def symbol_info(self, s): return Info(True, 0.01, 0.01, 100.0, 0, 0.01, 2) if s in self.data else None
    def symbol_select(self, s, v): return True
    def symbol_info_tick(self, s): c = float(self.data[s][self.n - 1]["close"]); return Tick(c + 0.1, c)
    def copy_rates_from_pos(self, s, tf, pos, n): return self.data[s][: self.n][-n:]
    def order_calc_profit(self, t, s, vol, entry, sl): return -abs(entry - sl) * vol * 100
    def positions_get(self, **kw): return list(self.positions)

    def order_send(self, req):
        self.sent.append(req)
        if req["action"] == self.TRADE_ACTION_SLTP:
            if self.sltp_fails:
                return Res(10013, 0)
            self.positions = [p._replace(sl=req["sl"], tp=req["tp"]) if p.ticket == req["position"] else p for p in self.positions]
            return Res(self.TRADE_RETCODE_DONE, 0)
        if "position" in req:
            self.positions = [p for p in self.positions if p.ticket != req["position"]]
            return Res(self.TRADE_RETCODE_DONE, req["price"])
        sl, tp = (0.0, 0.0) if self.strip_sl else (req["sl"], req["tp"])
        self.positions.append(Pos(len(self.sent), req["symbol"], req["type"], req["volume"], sl, tp, req["magic"], 0.0, req["price"]))
        return Res(self.TRADE_RETCODE_DONE, req["price"])


def signal_series():
    """Anstieg, Rücksetzer bis zur 50er Linie, dann bullische Kerze darüber: ma_pullback(50, 10, 0.5) gibt am letzten Balken ein Signal."""
    up = list(np.linspace(100, 160, 300)) + list(np.linspace(160, 152, 6))
    ma = pd.Series(up).rolling(50).mean().iloc[-1]
    return up + [ma + 1.0]


def cfg(**over):
    c = types.SimpleNamespace(**{k: getattr(base_cfg, k) for k in dir(base_cfg) if k.isupper()})
    c.PROFILES = [{"name": "video", "enabled": True, "magic": 7, "markets": {"XAUUSD": "H4"},
                   "strategy": {"type": "ma_pullback", "params": {"ma_period": 50, "slope_bars": 10, "touch_pct": 0.5, "exit_pct": 3.0}},
                   "allow_short": False, "risk_percent": 1.0, "atr_stop_mult": 2.0, "rr": 2.0}]
    for k, v in over.items():
        setattr(c, k, v)
    return c


def run_signal(tmp_path, mt5=None, c=None):
    series = signal_series()
    mt5 = mt5 or FakeMT5({"XAUUSD": bars(series + [series[-1]])})
    r = Runner(mt5, c or cfg(), tmp_path)
    r.connect()
    mt5.n = len(series)          # letzte geschlossene Kerze = Vorgängerbalken, aktuelle Kerze noch in Bildung
    r.step()                     # erstes Sehen: keine Alt-Signale
    assert not mt5.positions
    mt5.n = len(series) + 1      # neue Kerze ist geschlossen worden
    r.step()
    return r, mt5


def test_signal_opens_protected_position_with_risk_limit(tmp_path):
    r, mt5 = run_signal(tmp_path)
    assert len(mt5.positions) == 1
    p = mt5.positions[0]
    assert p.magic == 7 and p.sl > 0 and p.tp > 0
    price = mt5.sent[0]["price"]
    assert p.sl < price < p.tp and abs((p.tp - price) / (price - p.sl) - 2.0) < 0.05
    assert (price - p.sl) * p.volume * 100 <= 10_000 * 0.01 * 1.0001   # höchstens 1 % Risiko
    assert (tmp_path / "mt5bot_journal.csv").read_text(encoding="utf-8").count("OPEN") == 1


def test_real_account_is_refused(tmp_path):
    mt5 = FakeMT5({"XAUUSD": bars(signal_series())}, mode=2)
    with pytest.raises(RuntimeError, match="SICHERHEITSSTOPP"):
        Runner(mt5, cfg(), tmp_path).connect()


def test_one_position_per_symbol_and_global_limit(tmp_path):
    r, mt5 = run_signal(tmp_path)
    mt5.n += 1
    mt5.data["XAUUSD"] = bars(signal_series() + [signal_series()[-1]] * 2)
    r.step()
    assert len(mt5.positions) == 1
    c = cfg(MAX_OPEN_POSITIONS=0)
    r2, mt52 = run_signal(tmp_path / "x" if (tmp_path / "x").mkdir() is None else tmp_path, c=c)
    assert not mt52.positions


def test_daily_loss_limit_blocks_new_trades(tmp_path):
    series = signal_series()
    mt5 = FakeMT5({"XAUUSD": bars(series + [series[-1]])})
    r = Runner(mt5, cfg(), tmp_path)
    r.connect()
    mt5.n = len(series)
    r.step()
    assert r.day_check()
    mt5.equity = 10_000 * 0.96           # -4 % gegenüber Tagesanfang, Limit 3 %
    mt5.n += 1
    r.step()
    assert not mt5.positions and not r.day_check()


def test_kill_switch_closes_everything(tmp_path):
    r, mt5 = run_signal(tmp_path)
    assert mt5.positions
    (tmp_path / "KILL_SWITCH").write_text("")
    r.step()
    assert not mt5.positions


def test_protection_watchdog_repairs_or_closes(tmp_path):
    r, mt5 = run_signal(tmp_path, mt5=FakeMT5({"XAUUSD": bars(signal_series() * 1 + [signal_series()[-1]])}, strip_sl=True))
    assert mt5.positions and mt5.positions[0].sl > 0 and mt5.positions[0].tp > 0, "Schutz nachgerüstet"
    (tmp_path / "b").mkdir()
    r2, mt52 = run_signal(tmp_path / "b", mt5=FakeMT5({"XAUUSD": bars(signal_series() + [signal_series()[-1]])}, strip_sl=True, sltp_fails=True))
    assert not mt52.positions, "ungeschützte Position wird sofort geschlossen"


def test_config_validation(tmp_path):
    c = cfg()
    c.PROFILES.append({**c.PROFILES[0], "name": "zweites"})   # gleiche Magic Number
    with pytest.raises(ValueError, match="Magic"):
        Runner(FakeMT5({}), c, tmp_path)
    c2 = cfg()
    c2.PROFILES[0]["risk_percent"] = 5.0
    with pytest.raises(ValueError, match="risk_percent"):
        Runner(FakeMT5({}), c2, tmp_path)


def test_default_config_builds_all_strategies():
    c = types.SimpleNamespace(**{k: getattr(base_cfg, k) for k in dir(base_cfg) if k.isupper()})
    for p in c.PROFILES:
        make_strategy(p["strategy"], p["allow_short"])


def test_rsi_pullback_signals_after_dip_in_uptrend():
    s = RsiPullback({"params": {"trend_len": 50, "rsi_len": 14, "oversold": 35, "buffer_atr": 0.0}})
    close = list(np.linspace(100, 300, 300)) + list(np.linspace(300, 282, 5)) + list(np.linspace(282, 291, 6))
    df = pd.DataFrame(bars(close)).assign(time=lambda d: pd.to_datetime(d.time, unit="s", utc=True)).set_index("time")
    hits = [i for i in range(120, len(df)) if s.entry(df.iloc[: i + 1]) == "long"]
    assert hits, "RSI kreuzt nach dem Rücksetzer im Aufwärtstrend über die Schwelle"
    assert s.entry(df.iloc[:200]) is None and 300 < hits[0] < len(df)
    with pytest.raises(ValueError):
        RsiPullback({"params": {"oversold": 55}}, allow_short=True)


def test_divergence_needs_reference_and_waits_for_data():
    s = GoldSilverDivergence({"params": {"reference": "XAGUSD"}})
    assert s.needs == ["XAGUSD"]
    df = pd.DataFrame(bars(np.linspace(100, 110, 300))).assign(time=lambda d: pd.to_datetime(d.time, unit="s", utc=True)).set_index("time")
    assert s.entry(df, None) is None and s.entry(df, {"XAGUSD": df.iloc[:50]}) is None
