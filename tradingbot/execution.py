"""Modul 6: Order-Ausführung. Paper-Broker (Simulation) und Live-Broker (ccxt).

Jede Long-Position hat immer einen Stop-Loss. Live wird er als Stop-Order bei der
Börse hinterlegt; schlägt das fehl, wird die Position sofort wieder geschlossen.
"""
from __future__ import annotations

import logging
import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any, Optional

from .config import Config

log = logging.getLogger(__name__)


class StopOrderLost(Exception):
    """Die hinterlegte Stop-Order existiert nicht mehr (storniert/abgelehnt)."""


class StopPlacementError(Exception):
    """Der Stop-Loss konnte nicht platziert werden; die Position wurde wieder geschlossen."""


class InsufficientFunds(Exception):
    pass


@dataclass
class Fill:
    price: float
    amount: float
    fee: float
    order_id: Optional[str] = None
    stop_order_id: Optional[str] = None
    tp_order_id: Optional[str] = None
    reason: Optional[str] = None          # z. B. "Take-Profit (Broker)", wenn der Broker selbst geschlossen hat


@dataclass
class Position:
    symbol: str
    amount: float
    entry_price: float
    stop: float
    take_profit: float
    entry_fee: float
    opened_at: str                       # ISO-Zeitstempel (UTC)
    strategy_spec: dict[str, Any] = field(default_factory=dict)
    strategy_name: str = ""
    regime: str = ""
    reason: str = ""
    stop_order_id: Optional[str] = None
    side: int = 1                        # 1 = long, -1 = short (nur Forex)
    tp_order_id: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Position":
        return cls(**d)


class SpotLongOnly:
    """Einheitliche Broker-Schnittstelle für Spot-Broker (nur Kauf, kein Leerverkauf)."""

    manages_take_profit = False

    def open_position(self, symbol: str, side: int, amount: float, stop: float, take_profit: float,
                      ref_price: float) -> Fill:
        if side != 1:
            raise ValueError("Spot-Handel: nur Long-Positionen möglich")
        return self.open_long(symbol, amount, stop, ref_price)

    def close_position(self, pos: Position, ref_price: float) -> Fill:
        return self.close_long(pos, ref_price)


class PaperBroker(SpotLongOnly):
    """Simuliert Orders mit Gebühren und Slippage; es werden keine echten Orders gesendet."""

    mode = "paper"

    def __init__(self, cfg: Config, state: dict):
        self.fee = cfg.costs.fee_pct / 100
        self.slip = cfg.costs.slippage_pct / 100
        self.s = state.setdefault("paper", {"cash": float(cfg.capital.start)})

    def cash(self) -> float:
        return float(self.s["cash"])

    def open_long(self, symbol: str, amount: float, stop: float, ref_price: float) -> Fill:
        px = ref_price * (1 + self.slip)
        fee = amount * px * self.fee
        cost = amount * px + fee
        if cost > self.cash() + 1e-9:
            raise InsufficientFunds(f"Paper-Guthaben {self.cash():.2f} reicht nicht für {cost:.2f}")
        self.s["cash"] = self.cash() - cost
        return Fill(px, amount, fee, order_id=f"paper-{uuid.uuid4().hex[:8]}")

    def close_long(self, pos: Position, ref_price: float) -> Fill:
        px = ref_price * (1 - self.slip)
        fee = pos.amount * px * self.fee
        self.s["cash"] = self.cash() + pos.amount * px - fee
        return Fill(px, pos.amount, fee, order_id=f"paper-{uuid.uuid4().hex[:8]}")

    def check_stop(self, pos: Position, low_since_entry: float, last_price: float) -> Optional[Fill]:
        """Stop gilt als ausgelöst, wenn der Kurs seit dem Einstieg den Stop erreicht hat."""
        if low_since_entry > pos.stop:
            return None
        return self.close_long(pos, min(pos.stop, last_price))


class LiveBroker(SpotLongOnly):
    """Echte Orders über ccxt. Wird nur bei live_trading: true erzeugt."""

    mode = "live"

    def __init__(self, cfg: Config, exchange: Any = None):
        self.cfg = cfg
        self.quote = cfg.quote
        self.fee_rate = cfg.costs.fee_pct / 100
        if exchange is None:
            import ccxt

            key, secret = cfg.live_credentials()
            exchange = getattr(ccxt, cfg.exchange.id)(
                {"apiKey": key, "secret": secret, "enableRateLimit": True}
            )
        self.ex = exchange
        self.ex.load_markets()

    def cash(self) -> float:
        return float(self.ex.fetch_balance().get("free", {}).get(self.quote, 0.0) or 0.0)

    def base_balance(self, symbol: str) -> float:
        base = symbol.split("/")[0]
        return float(self.ex.fetch_balance().get("total", {}).get(base, 0.0) or 0.0)

    def _wait_fill(self, order: dict, symbol: str, attempts: int = 15) -> Fill:
        oid = order["id"]
        for _ in range(attempts):
            o = self.ex.fetch_order(oid, symbol)
            if o.get("status") == "closed" and (o.get("filled") or 0) > 0:
                filled = float(o["filled"])
                px = float(o.get("average") or o.get("price") or 0.0)
                fee_info = o.get("fee") or {}
                fee = float(fee_info["cost"]) if fee_info.get("cost") is not None and \
                    fee_info.get("currency") in (None, self.quote) else filled * px * self.fee_rate
                return Fill(px, filled, fee, order_id=oid)
            if o.get("status") in ("canceled", "expired", "rejected"):
                break
            time.sleep(1)
        try:
            self.ex.cancel_order(oid, symbol)
        except Exception:  # noqa: BLE001
            pass
        raise RuntimeError(f"Order {oid} wurde nicht ausgeführt")

    def open_long(self, symbol: str, amount: float, stop: float, ref_price: float) -> Fill:
        fill = self._wait_fill(self.ex.create_order(symbol, "market", "buy", amount), symbol)
        try:
            stop_order = self.ex.create_order(
                symbol, "market", "sell", fill.amount, None,
                {"stopLossPrice": float(self.ex.price_to_precision(symbol, stop))},
            )
            fill.stop_order_id = stop_order["id"]
        except Exception as exc:  # noqa: BLE001 - nie ohne Stop-Loss im Markt bleiben
            log.critical("Stop-Loss für %s nicht platzierbar (%s) – Position wird sofort geschlossen", symbol, exc)
            self._market_sell(symbol, fill.amount)
            raise StopPlacementError(str(exc)) from exc
        return fill

    def _market_sell(self, symbol: str, amount: float) -> Fill:
        base_free = float(self.ex.fetch_balance().get("free", {}).get(symbol.split("/")[0], amount) or 0.0)
        qty = float(self.ex.amount_to_precision(symbol, min(amount, base_free) if base_free > 0 else amount))
        return self._wait_fill(self.ex.create_order(symbol, "market", "sell", qty), symbol)

    def close_long(self, pos: Position, ref_price: float) -> Fill:
        if pos.stop_order_id:
            try:
                self.ex.cancel_order(pos.stop_order_id, pos.symbol)
            except Exception as exc:  # noqa: BLE001 - evtl. schon ausgelöst/storniert
                log.warning("Stop-Order %s konnte nicht storniert werden: %s", pos.stop_order_id, exc)
        return self._market_sell(pos.symbol, pos.amount)

    def check_stop(self, pos: Position, low_since_entry: float, last_price: float) -> Optional[Fill]:
        if not pos.stop_order_id:
            raise StopOrderLost("keine Stop-Order-ID vorhanden")
        o = self.ex.fetch_order(pos.stop_order_id, pos.symbol)
        status = o.get("status")
        if status == "closed":
            filled = float(o.get("filled") or pos.amount)
            px = float(o.get("average") or o.get("price") or pos.stop)
            fee_info = o.get("fee") or {}
            fee = float(fee_info["cost"]) if fee_info.get("cost") is not None and \
                fee_info.get("currency") in (None, self.quote) else filled * px * self.fee_rate
            return Fill(px, filled, fee, order_id=pos.stop_order_id)
        if status in ("canceled", "expired", "rejected"):
            raise StopOrderLost(f"Stop-Order {pos.stop_order_id} hat Status {status}")
        return None


class PaperMarginBroker:
    """Simuliertes Margin-Konto (Forex): Long und Short, Gewinn/Verlust wird beim Schließen verbucht.
    Es werden keine echten Orders gesendet. Konto-Währung = Quote-Währung der Paare (z. B. USD)."""

    mode = "paper"
    manages_take_profit = False

    def __init__(self, cfg: Config, state: dict):
        self.fee = cfg.costs.fee_pct / 100
        self.slip = cfg.costs.slippage_pct / 100
        self.s = state.setdefault("paper", {"cash": float(cfg.capital.start)})

    def cash(self) -> float:
        return float(self.s["cash"])

    def equity_value(self, positions: dict[str, Position], prices: dict[str, float]) -> float:
        return self.cash() + sum(p.side * p.amount * (prices.get(sym, p.entry_price) - p.entry_price)
                                 for sym, p in positions.items())

    def open_position(self, symbol: str, side: int, amount: float, stop: float, take_profit: float,
                      ref_price: float) -> Fill:
        px = ref_price * (1 + side * self.slip)
        fee = amount * px * self.fee
        self.s["cash"] = self.cash() - fee
        return Fill(px, amount, fee, order_id=f"paper-{uuid.uuid4().hex[:8]}")

    def close_position(self, pos: Position, ref_price: float) -> Fill:
        px = ref_price * (1 - pos.side * self.slip)
        fee = pos.amount * px * self.fee
        self.s["cash"] = self.cash() + pos.side * pos.amount * (px - pos.entry_price) - fee
        return Fill(px, pos.amount, fee, order_id=f"paper-{uuid.uuid4().hex[:8]}")

    def check_stop(self, pos: Position, extreme_since_entry: float, last_price: float) -> Optional[Fill]:
        """Long: Tief seit Einstieg <= Stop. Short: Hoch seit Einstieg >= Stop."""
        if pos.side == 1:
            return self.close_position(pos, min(pos.stop, last_price)) if extreme_since_entry <= pos.stop else None
        return self.close_position(pos, max(pos.stop, last_price)) if extreme_since_entry >= pos.stop else None
