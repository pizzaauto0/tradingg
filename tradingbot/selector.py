"""Modul 5: Strategie-Auswahl passend zum Marktzustand (nur zugelassene Strategien)."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .analysis import MarketState
from .strategies import Strategy, build_strategy


@dataclass
class Selection:
    strategy: Strategy
    record: dict[str, Any]
    score: float


def select_strategy(approved: list[dict[str, Any]], symbol: str, timeframe: str,
                    state: MarketState) -> Selection | None:
    """Wählt unter den zugelassenen Strategien (gleiches Symbol/Zeitrahmen) die mit dem
    höchsten Backtest-Sharpe-Ratio, die zur aktuellen Marktphase passt."""
    best: Selection | None = None
    for rec in approved:
        if rec.get("symbol") != symbol or rec.get("timeframe") != timeframe or not rec.get("active", True):
            continue
        try:
            strategy = build_strategy(rec["spec"])
        except (KeyError, ValueError):
            continue
        if state.regime not in strategy.regimes:
            continue
        m = rec.get("metrics", {})
        score = float(m.get("sharpe", 0.0)) + 1e-6 * float(m.get("return_pct", 0.0))
        if best is None or score > best.score:
            best = Selection(strategy, rec, score)
    return best
