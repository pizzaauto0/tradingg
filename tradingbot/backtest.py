"""Modul 4: Backtesting inkl. Gebühren und Slippage.

Modell: Signale entstehen am Schluss einer Kerze und werden zur Eröffnung der
nächsten ausgeführt (kein Look-ahead). Stop-Loss/Take-Profit werden intrabar
geprüft; liegen beide in derselben Kerze, gilt konservativ der Stop als zuerst
getroffen. Positionsgröße und Stops kommen aus dem Risikomodul – exakt wie live.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .analysis import atr, regime_series
from .config import BacktestCfg, Config
from .risk import position_size, stop_and_target
from .strategies import Strategy

WARMUP = 60


@dataclass
class Trade:
    entry_time: pd.Timestamp
    exit_time: pd.Timestamp
    entry_price: float
    exit_price: float
    amount: float
    pnl: float
    exit_reason: str


@dataclass
class BacktestResult:
    strategy: str
    symbol: str
    metrics: dict[str, float]
    trades: list[Trade] = field(default_factory=list)
    equity: pd.Series | None = None


class Backtester:
    def __init__(self, cfg: Config):
        self.cfg = cfg

    def run(self, df: pd.DataFrame, strategy: Strategy, symbol: str = "",
            initial: float | None = None) -> BacktestResult:
        cfg = self.cfg
        initial = float(initial or cfg.capital.start)
        n = len(df)
        if n <= WARMUP + 2:
            raise ValueError(f"Zu wenige Kerzen für den Backtest: {n}")
        fee = cfg.costs.fee_pct / 100
        slip = cfg.costs.slippage_pct / 100

        entry_sig = strategy.entry(df).to_numpy(dtype=bool)
        exit_sig = strategy.exit(df).to_numpy(dtype=bool)
        regime_ok = regime_series(df).isin(strategy.regimes).to_numpy()
        atr_arr = atr(df, cfg.risk.atr_period).to_numpy()
        o, h, l, c = (df[k].to_numpy() for k in ("open", "high", "low", "close"))
        idx = df.index

        cash, amount, entry_px, stop, tp = initial, 0.0, 0.0, 0.0, 0.0
        cost_basis, entry_i = 0.0, 0
        trades: list[Trade] = []
        equity = np.full(n, initial)

        def close_position(i: int, px: float, reason: str) -> None:
            nonlocal cash, amount
            proceeds = amount * px * (1 - fee)
            trades.append(Trade(idx[entry_i], idx[i], entry_px, px, amount, proceeds - cost_basis, reason))
            cash += proceeds
            amount = 0.0

        for i in range(WARMUP, n):
            # 1) Signale der vorherigen Kerze zur Eröffnung dieser Kerze ausführen
            if amount > 0 and exit_sig[i - 1]:
                close_position(i, o[i] * (1 - slip), "signal")
            elif amount == 0 and entry_sig[i - 1] and regime_ok[i - 1] and np.isfinite(atr_arr[i - 1]):
                px = o[i] * (1 + slip)
                stop_, tp_ = stop_and_target(px, atr_arr[i - 1], cfg.risk)
                size = position_size(cash, cash, px, stop_, cfg.risk, cfg.costs) if stop_ > 0 else 0.0
                if size > 0:
                    amount, entry_px, stop, tp, entry_i = size, px, stop_, tp_, i
                    cost_basis = amount * px * (1 + fee)
                    cash -= cost_basis
            # 2) Stop-Loss / Take-Profit innerhalb der Kerze
            if amount > 0:
                if l[i] <= stop:
                    close_position(i, min(stop, o[i]) * (1 - slip), "stop_loss")
                elif h[i] >= tp:
                    close_position(i, max(tp, 0.0) * (1 - slip), "take_profit")
            equity[i] = cash + amount * c[i]

        if amount > 0:  # offene Position zum letzten Kurs bewerten
            close_position(n - 1, c[-1] * (1 - slip), "end_of_data")
            equity[-1] = cash

        eq = pd.Series(equity, index=idx)
        metrics = self._metrics(eq, trades, initial)
        return BacktestResult(strategy.name, symbol, metrics, trades, eq)

    def _metrics(self, eq: pd.Series, trades: list[Trade], initial: float) -> dict[str, float]:
        cfg = self.cfg
        eq = eq.iloc[WARMUP:]
        rets = eq.pct_change().dropna()
        bars_per_year = 365 * 86400 / cfg.timeframe_seconds
        std = rets.std(ddof=0)
        sharpe = float(rets.mean() / std * np.sqrt(bars_per_year)) if std > 0 else 0.0
        drawdown = (eq / eq.cummax() - 1).min() * 100
        wins = [t.pnl for t in trades if t.pnl > 0]
        losses = [-t.pnl for t in trades if t.pnl <= 0]
        profit_factor = min(sum(wins) / sum(losses), 999.0) if losses and sum(losses) > 0 else (999.0 if wins else 0.0)
        split = int(len(eq) * (1 - cfg.backtest.oos_fraction))
        oos_ret = (eq.iloc[-1] / eq.iloc[split] - 1) * 100 if split < len(eq) else 0.0
        return {
            "return_pct": float((eq.iloc[-1] / initial - 1) * 100),
            "max_drawdown_pct": float(-drawdown),
            "sharpe": sharpe,
            "win_rate_pct": float(len(wins) / len(trades) * 100) if trades else 0.0,
            "profit_factor": float(profit_factor),
            "trades": float(len(trades)),
            "oos_return_pct": float(oos_ret),
        }


def check_thresholds(metrics: dict[str, float], bt: BacktestCfg) -> tuple[bool, list[str]]:
    """Prüft die Mindestwerte; gibt (zugelassen, Liste der Verstöße) zurück."""
    checks = [
        (metrics["trades"] >= bt.min_trades, f"Trades {metrics['trades']:.0f} < {bt.min_trades}"),
        (metrics["return_pct"] >= bt.min_return_pct, f"Rendite {metrics['return_pct']:.2f}% < {bt.min_return_pct}%"),
        (metrics["max_drawdown_pct"] <= bt.max_drawdown_pct,
         f"Max Drawdown {metrics['max_drawdown_pct']:.2f}% > {bt.max_drawdown_pct}%"),
        (metrics["sharpe"] >= bt.min_sharpe, f"Sharpe {metrics['sharpe']:.2f} < {bt.min_sharpe}"),
        (metrics["win_rate_pct"] >= bt.min_win_rate_pct,
         f"Trefferquote {metrics['win_rate_pct']:.1f}% < {bt.min_win_rate_pct}%"),
        (metrics["profit_factor"] >= bt.min_profit_factor,
         f"Profit Factor {metrics['profit_factor']:.2f} < {bt.min_profit_factor}"),
        (metrics["oos_return_pct"] >= bt.min_oos_return_pct,
         f"Out-of-Sample-Rendite {metrics['oos_return_pct']:.2f}% < {bt.min_oos_return_pct}%"),
    ]
    failures = [msg for ok, msg in checks if not ok]
    return not failures, failures
