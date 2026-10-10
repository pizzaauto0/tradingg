"""Modul 7: Risikomanagement (hat Vorrang vor allem anderen)."""
from __future__ import annotations

from datetime import datetime
from pathlib import Path

from .config import Config, CostsCfg, RiskCfg


def stop_and_target(entry: float, atr_value: float, risk: RiskCfg) -> tuple[float, float]:
    """Stop-Loss und Take-Profit aus ATR. Gibt (0, 0) zurück, wenn ATR unbrauchbar ist."""
    dist = atr_value * risk.atr_stop_mult
    if not dist > 0 or entry - dist <= 0:
        return 0.0, 0.0
    return entry - dist, entry + dist * risk.take_profit_rr


def position_size(equity: float, cash: float, entry: float, stop: float,
                  risk: RiskCfg, costs: CostsCfg) -> float:
    """Positionsgröße so, dass ein Stop-Out inkl. Gebühren/Slippage höchstens
    risk_per_trade_pct des Kapitals kostet; zusätzlich begrenzt durch
    max_position_pct und verfügbares Bargeld (kein Hebel)."""
    if stop <= 0 or entry <= stop:
        return 0.0
    cost = (costs.fee_pct + costs.slippage_pct) / 100
    per_unit_risk = (entry - stop) + (entry + stop) * cost
    amount = equity * risk.risk_per_trade_pct / 100 / per_unit_risk
    amount = min(amount, equity * risk.max_position_pct / 100 / entry)
    # Kauf kostet entry * (1 + slippage) * (1 + fee) je Einheit (multiplikativ, nicht additiv)
    amount = min(amount, cash / (entry * (1 + costs.slippage_pct / 100) * (1 + costs.fee_pct / 100)))
    return max(amount, 0.0)


class RiskManager:
    """Tagesverlust-Limit, Positionslimit und Kill Switch. Zustand liegt in state['risk']."""

    def __init__(self, cfg: Config, state: dict):
        self.cfg = cfg
        self.rcfg = cfg.risk
        self.state = state.setdefault("risk", {})

    # ---- Tageslimit
    def roll_day(self, now: datetime, equity: float) -> None:
        day = now.strftime("%Y-%m-%d")
        if self.state.get("day") != day:
            self.state.update(day=day, start_equity=equity, halted=False)

    @property
    def halted(self) -> bool:
        return bool(self.state.get("halted"))

    def daily_pnl_pct(self, equity: float) -> float:
        start = self.state.get("start_equity") or equity
        return (equity / start - 1) * 100

    def check_daily_limit(self, equity: float) -> bool:
        """True, wenn das Limit genau jetzt erreicht wurde (dann ist der Bot für den Tag gestoppt)."""
        if self.halted:
            return False
        if self.daily_pnl_pct(equity) <= -self.rcfg.max_daily_loss_pct:
            self.state["halted"] = True
            return True
        return False

    # ---- Positionslimit
    def can_open(self, n_open: int) -> tuple[bool, str]:
        if self.halted:
            return False, "Tagesverlust-Limit erreicht – kein Handel bis zum nächsten UTC-Tag"
        if n_open >= self.rcfg.max_open_positions:
            return False, f"Maximale Anzahl offener Positionen erreicht ({self.rcfg.max_open_positions})"
        return True, ""

    def sizing_equity(self, equity: float) -> float:
        """Live: nie mehr als das konfigurierte Kapital einsetzen."""
        return min(equity, self.cfg.capital.start) if self.cfg.live_trading else equity

    # ---- Kill Switch
    @property
    def kill_switch_path(self) -> Path:
        return Path(self.rcfg.kill_switch_file)

    def kill_switch_active(self) -> bool:
        return self.kill_switch_path.exists()
