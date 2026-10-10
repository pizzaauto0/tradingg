import pytest
import yaml

from tradingbot.config import ConfigError, load_config
from tradingbot.risk import RiskManager, position_size, stop_and_target
from tradingbot.util import utcnow


def test_default_config_file_loads_and_is_paper():
    cfg = load_config("config.yaml")
    assert cfg.live_trading is False and cfg.mode == "paper"


def test_unknown_key_and_excess_risk_rejected(tmp_path):
    p = tmp_path / "c.yaml"
    p.write_text(yaml.safe_dump({"risk": {"risk_per_trade_pct": 3.0}}))
    with pytest.raises(ConfigError):
        load_config(p)
    p.write_text(yaml.safe_dump({"risk": {"risk_per_trad_pct": 1.0}}))
    with pytest.raises(ConfigError):
        load_config(p)


def test_live_requires_credentials(cfg, monkeypatch):
    monkeypatch.delenv(cfg.exchange.api_key_env, raising=False)
    with pytest.raises(ConfigError):
        cfg.live_credentials()


def test_position_size_risks_at_most_configured_percent(cfg):
    equity, entry = 1000.0, 100.0
    stop, _ = stop_and_target(entry, 0.5, cfg.risk)  # Stop 99, enger Stop -> Cap durch max_position_pct
    amount = position_size(equity, equity, entry, stop, cfg.risk, cfg.costs)
    assert amount * entry <= equity * cfg.risk.max_position_pct / 100 + 1e-9
    stop, _ = stop_and_target(entry, 5.0, cfg.risk)  # Stop 90 -> Risiko-Limit greift
    amount = position_size(equity, equity, entry, stop, cfg.risk, cfg.costs)
    cost = (cfg.costs.fee_pct + cfg.costs.slippage_pct) / 100
    loss = amount * ((entry - stop) + (entry + stop) * cost)
    assert loss == pytest.approx(equity * cfg.risk.risk_per_trade_pct / 100)


def test_daily_limit_and_max_positions(cfg):
    rm = RiskManager(cfg, {})
    rm.roll_day(utcnow(), 1000.0)
    assert rm.can_open(0)[0]
    assert not rm.can_open(cfg.risk.max_open_positions)[0]
    assert not rm.check_daily_limit(960.0)
    assert rm.check_daily_limit(949.0)           # -5.1 %
    assert rm.halted and not rm.can_open(0)[0]
    assert not rm.check_daily_limit(900.0)       # meldet nur einmal


def test_kill_switch_file(cfg):
    rm = RiskManager(cfg, {})
    assert not rm.kill_switch_active()
    rm.kill_switch_path.write_text("x")
    assert rm.kill_switch_active()
