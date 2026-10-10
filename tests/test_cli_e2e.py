import time

import pytest
import yaml

import main as cli
from conftest import make_ohlcv
from tradingbot.data import MarketData


class FakeExchange:
    id = "fake"

    def __init__(self, *_):
        n = 3500
        end = int(time.time() // 900 * 900) * 1000 - 900_000   # letzte Kerze liegt schon vollständig zurück
        start = end - (n - 1) * 900_000
        df = make_ohlcv(n, drift=0.0004, vol=0.003, seed=21)
        self.rows = [[start + i * 900_000, *map(float, r)] for i, r in enumerate(df.to_numpy())]

    def fetch_ohlcv(self, symbol, tf, since=None, limit=None):
        rows = [r for r in self.rows if since is None or r[0] >= since]
        return rows[:limit] if since is not None else rows[-(limit or 300):]

    def fetch_ticker(self, symbol):
        return {"last": self.rows[-1][4]}

    def load_markets(self): pass
    def amount_to_precision(self, s, a): return f"{a:.6f}"
    def market(self, s): return {"limits": {"amount": {"min": 0.0001}, "cost": {"min": 5}}}


@pytest.fixture
def cfg_path(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(MarketData, "_make_exchange", staticmethod(lambda _id: FakeExchange()))
    path = tmp_path / "config.yaml"
    path.write_text(yaml.safe_dump({
        "market": {"symbols": ["BTC/USD"], "history_exchange": ""},
        "backtest": {"min_trades": 5, "min_return_pct": -100, "max_drawdown_pct": 100, "min_sharpe": -100,
                     "min_win_rate_pct": 0, "min_profit_factor": 0, "min_oos_return_pct": -100},
        "paths": {"data_dir": str(tmp_path / "data")},
        "risk": {"kill_switch_file": str(tmp_path / "KILL_SWITCH")},
    }))
    return str(path)


def test_research_run_status_kill(cfg_path, capsys):
    assert cli.main(["--config", cfg_path, "research"]) == 0
    out = capsys.readouterr().out
    assert "AKTIV" in out and "Sharpe" in out
    assert cli.main(["--config", cfg_path, "run", "--once"]) == 0
    assert cli.main(["--config", cfg_path, "status"]) == 0
    assert "PAPER" in capsys.readouterr().out
    assert cli.main(["--config", cfg_path, "kill"]) == 0
    assert cli.main(["--config", cfg_path, "run", "--once"]) == 0   # Kill Switch -> flatten + Ende


def test_live_without_keys_is_refused(cfg_path, monkeypatch):
    monkeypatch.delenv("EXCHANGE_API_KEY", raising=False)
    cfg = yaml.safe_load(open(cfg_path))
    cfg["live_trading"] = True
    yaml.safe_dump(cfg, open(cfg_path, "w"))
    assert cli.main(["--config", cfg_path, "run", "--once"]) == 2
