"""Tests der App-Schicht: Einstellungen, Strategie-Prüfung, Auto-Profil, Neu laden."""
import time

import numpy as np
import pandas as pd
import pytest

from mt5bot import research, settings
from mt5bot.runner import Runner
from tests.test_mt5bot import FakeMT5, bars


def frame(n=2500, seed=1, drift=0.0004):
    rng = np.random.default_rng(seed)
    c = 100 * np.exp(np.cumsum(rng.normal(drift, 0.01, n)))
    idx = pd.date_range("2015-01-01", periods=n, freq="D", tz="UTC")
    o = np.r_[c[0], c[:-1]]
    return pd.DataFrame({"open": o, "high": np.maximum(o, c) * 1.004, "low": np.minimum(o, c) * 0.996, "close": c, "volume": 1.0}, index=idx)


def test_settings_validate_limits_and_unknown_keys(tmp_path):
    ok = settings.validate({"general": {"daily_loss_limit_pct": 2, "evil": 1}, "profiles": {"video": {"risk_percent": 0.5}}})
    assert ok["general"] == {"daily_loss_limit_pct": 2.0} and ok["profiles"]["video"]["risk_percent"] == 0.5
    for bad in ({"general": {"daily_loss_limit_pct": 50}}, {"general": {"manual_risk_percent": 5}}, {"general": {"dashboard_control": "all"}},
                {"profiles": {"video": {"risk_percent": 3}}}, {"profiles": {"nope": {}}}, {"profiles": {"auto": {"markets": {"XAUUSD": "H3"}}}},
                {"profiles": {"auto": {"markets": {"X AU": "D1"}}}}, {"profiles": {"auto": {"mode": "x"}}}):
        with pytest.raises(ValueError):
            settings.validate(bad)


def test_settings_cannot_enable_real_account(tmp_path):
    settings.write(tmp_path, {"general": {"allow_real_account": True, "ALLOW_REAL_ACCOUNT": True}})
    assert settings.effective(tmp_path).ALLOW_REAL_ACCOUNT is False


def test_settings_overlay_applies(tmp_path):
    settings.write(tmp_path, {"general": {"max_open_positions": 5, "manual_risk_percent": 0.2},
                              "profiles": {"video": {"enabled": False}, "auto": {"enabled": True, "mode": "explore", "markets": {"EURUSD": "H4"}}}})
    c = settings.effective(tmp_path)
    assert c.MAX_OPEN_POSITIONS == 5 and c.MANUAL["risk_percent"] == 0.2
    by = {p["name"]: p for p in c.PROFILES}
    assert by["video"]["enabled"] is False and by["auto"]["enabled"] and by["auto"]["markets"] == {"EURUSD": "H4"} and by["auto"]["strategy"]["mode"] == "explore"
    v = settings.view(tmp_path)
    assert v["real_account_allowed"] is False and any(p["auto"] for p in v["profiles"])


def test_research_run_select_and_diagnose(tmp_path):
    rows = research.run({("XAUUSD", "D1"): frame(), ("EURUSD", "D1"): frame(seed=2, drift=-0.0003), ("TINY", "D1"): frame(100)}, "explore")
    assert any(r["metrics"] for r in rows)
    tiny = [r for r in rows if r["market"] == "TINY"]
    assert tiny and not tiny[0]["ok"] and "Kerzen" in tiny[0]["failures"][0]
    for r in rows:
        assert r["ok"] or r["failures"]
    act = research.select_active(rows, 2)
    assert all(a["market"] != "TINY" for a in act) and len(act) <= 9
    per_market = {}
    for a in act:
        per_market.setdefault(a["market"], []).append(a["type"])
    assert all(len(v) <= 2 and len(set(v)) == len(v) for v in per_market.values())
    data = research.finish(tmp_path, rows, "explore", 2500, 2)
    assert research.load(tmp_path)["mode"] == "explore" and "Prüfung" in research.summary_text(data)


def test_research_modes_have_fixed_lists():
    assert len(research.candidates("final")) == 3 and len(research.candidates("winrate")) == 5 and len(research.candidates("playbook")) == 5
    assert len(research.candidates("strict")) >= 30
    assert research.thresholds("explore").min_trades == 8 and research.thresholds("strict").min_trades == 20


def test_manual_toggle_and_due(tmp_path):
    with pytest.raises(ValueError):
        research.set_manual(tmp_path, "XAUUSD", "D1", "breakout", {}, "x", True)
    research.finish(tmp_path, [], "strict", 100, 2)
    d = research.set_manual(tmp_path, "XAUUSD", "D1", "breakout", {"lookback": 55, "exit_lookback": 20}, "Breakout", True)
    assert d["active"][0]["source"] == "manual"
    assert research.due(tmp_path, 0) is False and research.due(tmp_path, 1) is False
    d = research.set_manual(tmp_path, "XAUUSD", "D1", "breakout", {"lookback": 55, "exit_lookback": 20}, "Breakout", False)
    assert d["active"] == []


def app_runner(tmp_path, data):
    settings.write(tmp_path, {"profiles": {"video": {"enabled": False}, "auto": {"enabled": True, "markets": {"XAUUSD": "H4"}}}})
    mt5 = FakeMT5(data)
    r = Runner(mt5, settings.effective(tmp_path), tmp_path)
    r.overlay = True
    return r, mt5


def test_auto_profile_expands_from_research_and_reload(tmp_path):
    series = list(np.linspace(100, 200, 700))
    r, mt5 = app_runner(tmp_path, {"XAUUSD": bars(series)})
    assert r.profiles == []                              # noch keine Prüfung → nichts zu handeln
    research.finish(tmp_path, [], "strict", 10, 2)
    research.set_manual(tmp_path, "XAUUSD", "H4", "breakout", {"lookback": 55, "exit_lookback": 20}, "Breakout", True)
    r.connect()
    assert "Neu geladen" in r.reload_settings("test")
    assert [p["name"] for p in r.profiles] == ["auto:XAUUSD:breakout"] and r.profiles[0]["magic"] == 100301
    assert r.profiles[0]["markets"] == {"XAUUSD": "H4"}


def test_reload_only_with_overlay(tmp_path):
    r = Runner(FakeMT5({"XAUUSD": bars(list(np.linspace(1, 2, 50)))}), __import__("tests.test_mt5bot", fromlist=["cfg"]).cfg(), tmp_path)
    assert "nur in der App" in r.reload_settings()


def test_start_research_runs_in_background_and_activates(tmp_path):
    rng = np.random.default_rng(3)
    series = list(100 * np.exp(np.cumsum(rng.normal(0.0004, 0.01, 1500))))
    r, mt5 = app_runner(tmp_path, {"XAUUSD": bars(series)})
    r.cfg.RESEARCH_BARS = 1400
    r.connect()
    mt5.n = len(series)
    text = r.start_research("final", "test")
    assert "Prüfung gestartet" in text and r.start_research("final", "test") == "Eine Prüfung läuft schon."
    for _ in range(300):
        if not r.research_state["running"]:
            break
        time.sleep(0.1)
    assert r.research_state.get("finished") and (tmp_path / research.RESEARCH_FILE).exists()
    r.process_web_commands()                              # „reload“ aus dem Hintergrundfaden
    d = research.load(tmp_path)
    assert d["mode"] == "final" and len(d["results"]) == 3
    assert [p["name"] for p in r.profiles] == [f"auto:XAUUSD:{a['type']}" for a in d["active"]]


def test_web_commands_save_settings_and_toggle(tmp_path):
    r, mt5 = app_runner(tmp_path, {"XAUUSD": bars(list(np.linspace(100, 200, 700)))})
    r.connect()
    cid = r.submit_web_command({"type": "save_settings", "overlay": {"general": {"max_open_positions": 4}}})
    r.process_web_commands()
    assert "Gespeichert" in r.web_results[cid]["text"] and r.cfg.MAX_OPEN_POSITIONS == 4
    cid = r.submit_web_command({"type": "save_settings", "overlay": {"general": {"max_open_positions": 99}}})
    r.process_web_commands()
    assert r.web_results[cid]["text"].startswith("Fehler") and r.cfg.MAX_OPEN_POSITIONS == 4
