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
    def terminal_info(self): return namedtuple("TI", "connected trade_allowed")(True, getattr(self, "algo", True))

    def order_send(self, req):
        if not getattr(self, "algo", True):
            return Res(10027, 0)
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


def test_account_switch_resets_daily_baseline(tmp_path):
    mt5 = FakeMT5({"XAUUSD": bars(signal_series())})
    r = Runner(mt5, cfg(), tmp_path)
    r.connect()
    assert r.day_check()
    mt5.equity = 50_000.0                      # anderes Konto (auch mit anderer Nummer) mit ganz anderem Kapital
    mt5.account_info = lambda: Acc(2, "Demo-Server", 50_000.0, 50_000.0, "USD", 0)
    r2 = Runner(mt5, cfg(), tmp_path)          # gleicher Ordner: alte state-Datei mit Konto 1 und 10.000
    assert r2.day_check() and r2.state["login"] == 2 and r2.state["start_equity"] == 50_000.0


def test_snapshot_breakeven_timestop_and_dashboard(tmp_path):
    import json
    import urllib.request
    from datetime import datetime, timedelta, timezone

    from mt5bot.dashboard import serve

    c = cfg()
    c.PROFILES[0].update(breakeven_at_r=1.0, max_days=40)
    series = signal_series()
    mt5 = FakeMT5({"XAUUSD": bars(series + [series[-1]] + [series[-1] + 30] * 3)})
    r, mt5 = run_signal(tmp_path, mt5=mt5, c=c)
    pos = mt5.positions[0]
    entry, risk = pos.price_open, pos.price_open - pos.sl
    r.write_snapshot()
    snap = json.loads((tmp_path / "mt5bot_snapshot.json").read_text(encoding="utf-8"))
    p = snap["positions"][0]
    assert p["symbol"] == "XAUUSD" and p["profile"] == "video" and p["max_days"] == 40 and not p["breakeven"]
    assert abs(p["r"] - (p["price"] - entry) / risk) < 1e-6 and len(p["candles"]["c"]) == 120
    assert snap["account"]["demo"] and snap["markets"] and snap["next_bar"]

    mt5.n += 1                                  # Kurs steigt um +30 (weit über 1R): Stop auf Einstand
    r.step()
    pos = mt5.positions[0]
    assert pos.sl == entry
    r.write_snapshot()
    snap = json.loads((tmp_path / "mt5bot_snapshot.json").read_text(encoding="utf-8"))
    assert snap["positions"][0]["breakeven"] and snap["positions"][0]["max_r"] > 1

    url = serve(tmp_path, 0, open_browser=False)["local"]  # Port 0 = freier Port
    assert url.startswith("http://127.0.0.1:")
    html = urllib.request.urlopen(url).read().decode()
    assert "OFFENE POSITIONEN" in html
    api = json.loads(urllib.request.urlopen(url + "api/snapshot").read())
    assert api["positions"][0]["symbol"] == "XAUUSD"

    old = (datetime.now(timezone.utc) - timedelta(days=41)).isoformat()
    r.state["trades"][str(pos.ticket)]["opened"] = old
    r.manage_open()                             # Zeit-Stopp nach 40 Tagen
    assert not mt5.positions


def test_foreign_positions_are_shown_but_not_managed(tmp_path):
    import json
    r, mt5 = run_signal(tmp_path)
    mt5.positions.append(Pos(999, "XAUUSD", 0, 0.05, 1.0, 999.0, 100001, 5.0, 150.0))   # Position des Beispiel-Bots 1
    mt5.positions.append(Pos(998, "EURUSD", 1, 0.10, 0.0, 0.0, 0, -2.0, 1.1))            # manuell, ohne Daten
    mt5.data["EURUSD"] = bars(np.linspace(1.0, 1.1, 400))
    r.write_snapshot()
    snap = json.loads((tmp_path / "mt5bot_snapshot.json").read_text(encoding="utf-8"))
    names = {p["ticket"]: (p["profile"], p["own"]) for p in snap["positions"]}
    assert names[999] == ("1-Haupt-Bot", False) and names[998] == ("manuell", False)
    assert sum(own for _, own in names.values()) == 1
    (tmp_path / "KILL_SWITCH").write_text("")
    r.step()                                   # Kill-Switch schließt nur die eigenen Positionen
    assert {p.ticket for p in mt5.positions} == {999, 998}


def test_phone_access_requires_key(tmp_path):
    import urllib.error
    import urllib.request

    from mt5bot.dashboard import local_addresses, serve

    (tmp_path / "mt5bot_snapshot.json").write_text('{"positions": []}', encoding="utf-8")
    info = serve(tmp_path, 0, open_browser=False, lan=True)
    try:
        key = (tmp_path / "mt5bot_dashboard_key.txt").read_text(encoding="utf-8")
        assert len(key) >= 16 and all(f"key={key}" in u for u in info["phone"])
        assert urllib.request.urlopen(info["local"] + "api/snapshot").status == 200   # am PC ohne Schlüssel
        assert key in urllib.request.urlopen(info["local"] + "api/phone").read().decode()
        ips = local_addresses()
        if not ips:
            pytest.skip("keine Netzwerkadresse in dieser Umgebung")
        port = info["server"].server_address[1]
        base = f"http://{ips[0]}:{port}/"
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # direkt, nicht über einen Proxy
        with pytest.raises(urllib.error.HTTPError) as e:
            opener.open(base + "api/snapshot")
        assert e.value.code == 403
        with pytest.raises(urllib.error.HTTPError):
            opener.open(base + "api/snapshot?key=falsch")
        with pytest.raises(urllib.error.HTTPError):
            opener.open(base + f"api/phone?key={key}")           # Handy-Link wird nur am PC verraten
        assert opener.open(base + f"api/snapshot?key={key}").status == 200
    finally:
        info["server"].shutdown()


def test_decision_log_and_hourly_report_explain_why(tmp_path):
    r, mt5 = run_signal(tmp_path)
    day = [f for f in (tmp_path / "logs").glob("entscheidungen_*.log")]
    assert day, "Entscheidungsprotokoll angelegt"
    text = day[0].read_text(encoding="utf-8")
    assert "KAUF" in text and "Frage 1" in text and "Frage 2" in text and "✔" in text
    # Begründung bleibt beim offenen Trade gespeichert (auch nach Neustart)
    reason = next(iter(r.state["trades"].values()))["reason"]
    assert "LONG XAUUSD" in reason and "Linie" in reason and "Risiko" in reason

    assert r.maybe_report(force=True)
    rep = next((tmp_path / "logs").glob("bericht_*.txt")).read_text(encoding="utf-8")
    for part in ("1. KONTO", "2. OFFENE POSITIONEN", "WARUM GEKAUFT", "3. EREIGNISSE", "4. MARKTANALYSE", "Frage 1"):
        assert part in rep, part
    assert r.events == [] and r.state["last_report"]
    assert not r.maybe_report()                  # erst nach REPORT_MINUTES wieder fällig
    r.state["last_report"] = "2000-01-01T00:00:00+00:00"
    assert r.maybe_report()


def test_no_signal_is_logged_with_missing_conditions(tmp_path):
    series = list(np.linspace(100, 160, 330))     # glatter Anstieg ohne Rücksetzer: kein Einstieg
    mt5 = FakeMT5({"XAUUSD": bars(series)})
    r = Runner(mt5, cfg(), tmp_path)
    r.connect()
    mt5.n = 320
    r.step()
    mt5.n = 321
    r.step()
    assert not mt5.positions
    text = next((tmp_path / "logs").glob("entscheidungen_*.log")).read_text(encoding="utf-8")
    assert "KEIN KAUF" in text and "✘" in text and "Rücksetzer bis zur Linie" in text
    ev = [e for e in r.events if e["kind"] == "KEIN KAUF"]
    assert ev and any(not ok for ok, _ in ev[-1]["checks"])


def test_blocked_signal_by_position_limit_is_explained(tmp_path):
    r, mt5 = run_signal(tmp_path, c=cfg(MAX_OPEN_POSITIONS=0))
    assert not mt5.positions
    assert any(e["kind"] == "BLOCKIERT" and "Positionslimit" in e["text"] for e in r.events)


def test_broker_side_close_is_recorded_with_reason(tmp_path):
    r, mt5 = run_signal(tmp_path)
    ticket = mt5.positions[0].ticket
    Deal = namedtuple("Deal", "entry profit commission swap price reason")
    mt5.DEAL_REASON_SL, mt5.DEAL_REASON_TP = 3, 4
    mt5.history_select = lambda a, b: True
    mt5.history_deals_get = lambda position=None: [Deal(1, -97.0, -1.0, 0.0, 153.79, 3)]
    mt5.positions.clear()                        # Broker hat die Position über den Stop geschlossen
    r.track_positions()
    ev = [e for e in r.events if e["kind"] == "VERKAUF"]
    assert ev and "Stop-Loss getroffen" in ev[-1]["text"] and "-98.00" in ev[-1]["text"] and "ursprüngliche Begründung" in ev[-1]["text"]
    assert str(ticket) not in r.state["trades"]


def test_strategy_exit_params_override_profile_values(tmp_path):
    """Stop und Ziel der Strategie (wie getestet) haben Vorrang vor den Profilwerten."""
    c = cfg()
    c.PROFILES[0]["strategy"] = {"type": "ma_pullback", "params": {"ma_period": 50, "slope_bars": 10, "touch_pct": 0.5, "exit_pct": 3.0, "stop_mult": 4.0, "rr": 3.0}}
    r, mt5 = run_signal(tmp_path, c=c)
    p = mt5.positions[0]
    price = mt5.sent[0]["price"]
    assert abs((p.tp - price) / (price - p.sl) - 3.0) < 0.05           # Ziel = 3 x Stop (nicht 2)
    base_stop = price - p.sl
    r2, mt52 = run_signal(tmp_path / "b" if (tmp_path / "b").mkdir() is None else tmp_path, c=cfg())
    assert base_stop > (mt52.sent[0]["price"] - mt52.positions[0].sl) * 1.9     # 4 x ATR statt 2 x ATR
    assert "4xATR" in next(iter(r.state["trades"].values()))["reason"] and "3R" in next(iter(r.state["trades"].values()))["reason"]


def test_symbol_suffixes_and_aliases_resolve_broker_names(tmp_path):
    series = signal_series()
    for broker_name in ("XAUUSDm", "GOLD", "XAUUSD.a"):
        mt5 = FakeMT5({broker_name: bars(series)})
        r = Runner(mt5, cfg(), tmp_path)
        r.connect()
        assert r.symbols["XAUUSD"] == broker_name


def test_generated_profile_text_is_valid_and_usable(tmp_path):
    """survey.profil_erzeugen: erzeugter Text lässt sich einfügen und der Bot akzeptiert ihn."""
    import ast
    import json
    import subprocess
    import sys

    out = tmp_path / "out" / "nachpruefung_x"
    out.mkdir(parents=True)
    (out / "nachpruefung.json").write_text(json.dumps([
        {"nr": 1, "type": "squeeze_breakout", "params": {"period": 19, "bb_mult": 2.37, "kc_mult": 1.88, "stop_mult": 4.0, "rr": 3.0}, "name": "squeeze_breakout(...)",
         "verdict": "ROBUST", "robust": True, "pf": 1.74, "edge": 0.69, "trades_per_year": 3.1, "years_positive": "9/9", "robust_markets": ["Gold", "Silber", "Schwellenländer"]}]))
    import survey.profil_erzeugen as pe
    old = pe.OUT
    pe.OUT = tmp_path / "out"
    try:
        sys.argv = ["x", "--von", "nachpruefung_x", "--auto", "1"]
        assert pe.main() == 0
    finally:
        pe.OUT = old
    text = (tmp_path / "out" / "neues_profil.txt").read_text(encoding="utf-8")
    assert "Schwellenländer" in text and '"XAUUSD": "D1"' in text and '"XAGUSD": "D1"' in text
    profiles = ast.literal_eval("[" + text + "]")
    c = cfg()
    c.PROFILES = profiles
    mt5 = FakeMT5({"XAUUSD": bars(signal_series()), "XAGUSD": bars(signal_series())})
    r = Runner(mt5, c, tmp_path)
    assert r.profiles[0]["strat"].stop_mult(2.0) == 4.0 and r.profiles[0]["strat"].rr(2.0) == 3.0


def test_diagnose_explains_why_no_trade_and_counts_past_signals(tmp_path):
    series = signal_series()
    mt5 = FakeMT5({"XAUUSD": bars(series + [series[-1]])})
    r = Runner(mt5, cfg(), tmp_path)
    r.connect()
    mt5.n = len(series) + 1
    text = r.diagnose_text()
    for part in ("1. VERBINDUNG", "Algo-Handel", "2. MÄRKTE UND SIGNALE", "XAUUSD (H4)", "Rückblick:", "3. ERWARTUNG", "Jetzt: SIGNAL"):
        assert part in text, part
    mt5.algo = False
    assert "✘ 'Algo-Handel' im Terminal AN" in r.diagnose_text()
    mt5b = FakeMT5({})
    r2 = Runner(FakeMT5({"XAUUSD": bars(series)}), cfg(), tmp_path)
    r2.connect()
    r2.symbols.pop("XAUUSD")
    assert "NICHT gefunden" in r2.diagnose_text()


def test_replay_signals_matches_entry_on_each_bar():
    from mt5bot.signals import make_strategy, replay_signals
    s = make_strategy({"type": "ma_pullback", "params": {"ma_period": 50, "slope_bars": 10, "touch_pct": 0.5, "exit_pct": 3.0}}, False)
    close = list(np.linspace(100, 160, 300)) + list(np.linspace(160, 152, 6)) + [155.0] + list(np.linspace(155, 170, 30))
    import pandas as pd
    a = bars(close)
    df = pd.DataFrame(a).assign(time=lambda d: pd.to_datetime(d.time, unit="s", utc=True)).set_index("time")[["open", "high", "low", "close"]].assign(volume=1.0)
    fast = replay_signals(s, df, None, 100)
    slow = [df.index[i] for i in range(len(df) - 100, len(df)) if s.entry(df.iloc[: i + 1])]
    assert fast == slow and len(fast) >= 1


def test_algo_trading_off_is_reported_clearly_and_orders_explain_why(tmp_path):
    series = signal_series()
    mt5 = FakeMT5({"XAUUSD": bars(series + [series[-1]])})
    mt5.algo = False
    r = Runner(mt5, cfg(), tmp_path)
    r.connect()
    mt5.n = len(series)
    r.step()
    assert any(e["kind"] == "FEHLER" and "Algo-Handel AUS" in e["head"] for e in r.events)   # sofort gemeldet
    mt5.n += 1
    r.step()
    assert not mt5.positions
    err = [e for e in r.events if e["kind"] == "FEHLER" and "Order nicht ausgeführt" in e["text"]]
    assert err and "Algo-Handel im MetaTrader-Terminal ist AUS" in err[-1]["text"] and "10027" in err[-1]["text"]
    mt5.algo = True                                   # eingeschaltet: nächste Prüfung meldet 'wieder AN'
    r._algo_checked = -1e9
    r.algo_watch()
    assert any("wieder AN" in e["text"] for e in r.events)
