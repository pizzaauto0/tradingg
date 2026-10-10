"""Hauptschleife: verbindet Daten, Analyse, Auswahl, Risiko, Ausführung und Logging."""
from __future__ import annotations

import logging
import signal
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Optional

import pandas as pd

from .analysis import atr, classify_market
from .config import Config
from .data import MarketData
from .execution import (Fill, InsufficientFunds, Position, StopOrderLost, StopPlacementError)
from .notify import Notifier
from .risk import RiskManager, position_size, stop_and_target
from .selector import select_strategy
from .strategies import build_strategy
from .tradelog import TradeLog
from .util import atomic_write_json, read_json, utcnow

log = logging.getLogger(__name__)


class TradingEngine:
    def __init__(self, cfg: Config, data: MarketData, broker: Any, tradelog: TradeLog, notifier: Notifier,
                 state: dict, state_path: Path, approved: list[dict[str, Any]],
                 refresher: Optional[Callable[[], list[dict[str, Any]]]] = None):
        self.cfg = cfg
        self.data = data
        self.broker = broker
        self.tradelog = tradelog
        self.notifier = notifier
        self.state = state
        self.state_path = state_path
        self.approved = approved
        self.refresher = refresher
        self.risk = RiskManager(cfg, state)
        self.positions: dict[str, Position] = {
            s: Position.from_dict(p) for s, p in state.get("positions", {}).items()
        }
        self.last_candle: dict[str, str] = state.setdefault("last_candle", {})
        self.last_prices: dict[str, float] = {}
        self.stop_requested = False
        self._exited_this_tick: set[str] = set()

    # ------------------------------------------------------------ zustand
    def save_state(self) -> None:
        self.state["positions"] = {s: p.to_dict() for s, p in self.positions.items()}
        atomic_write_json(self.state_path, self.state)

    def equity(self) -> float:
        value = self.broker.cash()
        for sym, pos in self.positions.items():
            value += pos.amount * self.last_prices.get(sym, pos.entry_price)
        return value

    # ---------------------------------------------------------- hauptschleife
    def run_forever(self) -> None:
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, lambda *_: setattr(self, "stop_requested", True))
        self.notifier.send(f"Bot gestartet ({self.cfg.mode}), Symbole: {', '.join(self.cfg.market.symbols)}")
        while not self.stop_requested:
            try:
                self.tick()
            except Exception as exc:  # noqa: BLE001 - Schleife darf nie wegen eines Fehlers sterben
                log.exception("Fehler im Durchlauf")
                self.notifier.send(f"Fehler im Durchlauf: {type(exc).__name__}: {exc}")
            if self.stop_requested:
                break
            time.sleep(self.cfg.market.poll_seconds)
        self.save_state()
        note = "Offene Positionen bleiben durch ihre Stops geschützt." if self.positions else "Keine offenen Positionen."
        self.notifier.send(f"Bot beendet. {note}")

    def tick(self, now: Optional[datetime] = None) -> None:
        now = now or utcnow()
        if self.risk.kill_switch_active():
            self._kill(now)
            return
        self._maybe_refresh_strategies(now)
        self._exited_this_tick.clear()

        candles = self._load_candles(now)
        if not candles:
            log.warning("Keine Marktdaten erhalten – Durchlauf übersprungen")
            return
        for sym, (_, live) in candles.items():
            self.last_prices[sym] = float(live["close"].iloc[-1])

        is_new: dict[str, bool] = {}
        for sym, (closed, _) in candles.items():
            stamp = closed.index[-1].isoformat()
            is_new[sym] = sym in self.last_candle and self.last_candle[sym] != stamp
            if sym not in self.last_candle:  # beim ersten Sehen nicht auf alte Signale reagieren
                self.last_candle[sym] = stamp

        self.risk.roll_day(now, self.equity())
        self._manage_positions(candles, is_new, now)

        equity = self.equity()
        if self.risk.check_daily_limit(equity):
            msg = (f"Tagesverlust-Limit erreicht ({self.risk.daily_pnl_pct(equity):.2f}%). "
                   f"Kein Handel bis zum nächsten UTC-Tag.")
            self.notifier.send(msg)
            if self.cfg.risk.close_positions_on_daily_limit:
                self._flatten("Tagesverlust-Limit", now)
        if not self.risk.halted:
            self._look_for_entries(candles, is_new, now)

        for sym, (closed, _) in candles.items():
            self.last_candle[sym] = closed.index[-1].isoformat()
        self.save_state()

    # ------------------------------------------------------------- daten
    def _load_candles(self, now: datetime) -> dict[str, tuple[pd.DataFrame, pd.DataFrame]]:
        out = {}
        tf = self.cfg.timeframe_seconds
        for sym in self.cfg.market.symbols:
            try:
                live = self.data.fetch_recent(sym)
            except Exception as exc:  # noqa: BLE001
                log.warning("Kerzen für %s nicht ladbar: %s", sym, exc)
                continue
            forming = live.index[-1].timestamp() + tf > now.timestamp()
            closed = live.iloc[:-1] if forming else live
            if len(closed) < 150:
                log.warning("%s: zu wenige geschlossene Kerzen (%d)", sym, len(closed))
                continue
            out[sym] = (closed, live)
        return out

    # ------------------------------------------------------ positionen
    def _manage_positions(self, candles, is_new: dict[str, bool], now: datetime) -> None:
        tf = self.cfg.timeframe_seconds
        for sym, pos in list(self.positions.items()):
            if sym not in candles:
                continue
            closed, live = candles[sym]
            last = float(live["close"].iloc[-1])
            entry_candle = pd.Timestamp(pos.opened_at).floor(f"{tf}s")
            after = live[live.index > entry_candle]
            low_since = min(float(after["low"].min()) if len(after) else last, last)

            try:
                fill = self.broker.check_stop(pos, low_since, last)
            except StopOrderLost as exc:
                self.notifier.send(f"{sym}: Stop-Order verloren ({exc}) – Position wird geschlossen")
                self._close(pos, last, "Stop-Order verloren – Sicherheits-Schließung", now)
                continue
            if fill is not None:
                self._record_exit(pos, fill, f"Stop-Loss bei {pos.stop:.2f} ausgelöst", now)
                continue
            if last >= pos.take_profit:
                self._close(pos, last, f"Take-Profit {pos.take_profit:.2f} erreicht", now)
                continue
            if is_new.get(sym):
                strategy = build_strategy(pos.strategy_spec)
                if bool(strategy.exit(closed).iloc[-1]):
                    self._close(pos, last, f"Ausstiegssignal der Strategie {strategy.name}", now)

    def _close(self, pos: Position, ref_price: float, reason: str, now: datetime) -> None:
        fill = self.broker.close_long(pos, ref_price)
        self._record_exit(pos, fill, reason, now)

    def _record_exit(self, pos: Position, fill: Fill, reason: str, now: datetime) -> None:
        pnl = (fill.price - pos.entry_price) * fill.amount - pos.entry_fee - fill.fee
        self.positions.pop(pos.symbol, None)
        self._exited_this_tick.add(pos.symbol)  # kein Wiedereinstieg im selben Durchlauf
        self.last_prices.setdefault(pos.symbol, fill.price)
        equity = self.equity()
        self.tradelog.record(ts=now.isoformat(), mode=self.cfg.mode, symbol=pos.symbol, action="EXIT",
                             price=fill.price, amount=fill.amount, fee=fill.fee, pnl=pnl,
                             strategy=pos.strategy_name, regime=pos.regime, reason=reason, equity=equity)
        self.notifier.send(f"EXIT {pos.symbol} @ {fill.price:.2f} | PnL {pnl:+.2f} | {reason}")

    def _flatten(self, reason: str, now: datetime) -> None:
        for sym, pos in list(self.positions.items()):
            price = self.last_prices.get(sym, pos.entry_price)
            try:
                self._close(pos, price, reason, now)
            except Exception as exc:  # noqa: BLE001
                log.exception("Schließen von %s fehlgeschlagen", sym)
                self.notifier.send(f"WARNUNG: {sym} konnte nicht geschlossen werden: {exc}")

    def _kill(self, now: datetime) -> None:
        self.notifier.send("KILL SWITCH aktiv – alle Positionen werden geschlossen, Bot beendet sich.")
        for sym in self.cfg.market.symbols:  # aktuelle Kurse für die Bewertung
            try:
                self.last_prices[sym] = self.data.fetch_price(sym)
            except Exception:  # noqa: BLE001
                pass
        self._flatten("Kill Switch", now)
        self.save_state()
        if self.positions:
            self.notifier.send(f"WARNUNG: Nicht geschlossen: {', '.join(self.positions)} – bitte manuell prüfen!")
        self.stop_requested = True

    # ----------------------------------------------------------- einstiege
    def _look_for_entries(self, candles, is_new: dict[str, bool], now: datetime) -> None:
        for sym, (closed, live) in candles.items():
            if sym in self.positions or sym in self._exited_this_tick or not is_new.get(sym):
                continue
            ok, why = self.risk.can_open(len(self.positions))
            if not ok:
                log.info("Kein Einstieg: %s", why)
                return
            try:
                state = classify_market(closed)
            except ValueError as exc:
                log.warning("%s: Analyse nicht möglich: %s", sym, exc)
                continue
            selection = select_strategy(self.approved, sym, self.cfg.market.timeframe, state)
            if selection is None:
                log.info("%s: keine zugelassene Strategie für Marktphase %s", sym, state.regime)
                continue
            strategy = selection.strategy
            if not bool(strategy.entry(closed).iloc[-1]):
                continue

            price = float(live["close"].iloc[-1])
            atr_value = float(atr(closed, self.cfg.risk.atr_period).iloc[-1])
            stop, take_profit = stop_and_target(price, atr_value, self.cfg.risk)
            if stop <= 0:
                log.warning("%s: ATR unbrauchbar, kein Einstieg", sym)
                continue
            equity = self.equity()
            raw = position_size(self.risk.sizing_equity(equity), self.broker.cash(), price, stop,
                                self.cfg.risk, self.cfg.costs)
            amount = self.data.normalize_amount(sym, raw, price) if raw > 0 else 0.0
            if amount <= 0:
                log.info("%s: Positionsgröße unter Börsenminimum (roh %.8f) – übersprungen", sym, raw)
                continue
            self._open(sym, strategy, selection, state, closed, amount, price, stop, take_profit, equity, now)

    def _open(self, sym, strategy, selection, state, closed, amount, price, stop, take_profit, equity, now) -> None:
        risk_cash = amount * (price - stop)
        reason = (f"{strategy.explain(closed)}; Marktphase: {state.summary()}; "
                  f"Stop {stop:.2f} ({self.cfg.risk.atr_stop_mult}x ATR), Ziel {take_profit:.2f}; "
                  f"Risiko ca. {risk_cash:.2f} ({risk_cash / equity * 100:.2f}% des Kapitals); "
                  f"Backtest-Sharpe {selection.record.get('metrics', {}).get('sharpe', 0):.2f}")
        try:
            fill = self.broker.open_long(sym, amount, stop, price)
        except StopPlacementError as exc:
            self.notifier.send(f"{sym}: Einstieg abgebrochen, Stop-Loss nicht platzierbar ({exc}). Position geschlossen.")
            return
        except InsufficientFunds as exc:
            log.warning("%s: %s", sym, exc)
            return
        except Exception as exc:  # noqa: BLE001
            log.exception("Order für %s fehlgeschlagen", sym)
            self.notifier.send(f"{sym}: Order fehlgeschlagen: {exc}")
            return
        pos = Position(symbol=sym, amount=fill.amount, entry_price=fill.price, stop=stop, take_profit=take_profit,
                       entry_fee=fill.fee, opened_at=now.isoformat(), strategy_spec=strategy.to_spec(),
                       strategy_name=strategy.name, regime=state.regime, reason=reason,
                       stop_order_id=fill.stop_order_id)
        self.positions[sym] = pos
        self.last_prices[sym] = price
        self.save_state()  # Position sofort sichern
        self.tradelog.record(ts=now.isoformat(), mode=self.cfg.mode, symbol=sym, action="ENTRY", price=fill.price,
                             amount=fill.amount, fee=fill.fee, strategy=strategy.name, regime=state.regime,
                             reason=reason, equity=self.equity())
        self.notifier.send(f"ENTRY {sym} {fill.amount:.6f} @ {fill.price:.2f} | Stop {stop:.2f} | "
                           f"{strategy.name} | {state.regime}")

    # ------------------------------------------------------ strategien
    def _maybe_refresh_strategies(self, now: datetime) -> None:
        if self.refresher is None:
            return
        last = self.state.get("last_refresh")
        age_h = (now - datetime.fromisoformat(last)).total_seconds() / 3600 if last else None
        if age_h is not None and age_h < self.cfg.pipeline.revalidate_hours:
            return
        try:
            self.approved = self.refresher()
            self.notifier.send(f"Strategien neu geprüft: {len(self.approved)} zugelassen")
        except Exception as exc:  # noqa: BLE001 - alte Zulassungen gelten bis zum nächsten Erfolg weiter
            log.exception("Neuprüfung der Strategien fehlgeschlagen")
            self.notifier.send(f"Neuprüfung der Strategien fehlgeschlagen: {exc}")
        self.state["last_refresh"] = now.isoformat()

    # ----------------------------------------------------- abgleich (live)
    def reconcile(self) -> None:
        """Live: entfernt Positionen, die an der Börse nicht mehr existieren (z. B. Stop ausgelöst)."""
        if not hasattr(self.broker, "base_balance"):
            return
        for sym, pos in list(self.positions.items()):
            have = self.broker.base_balance(sym)
            if have < pos.amount * 0.99:
                self.notifier.send(f"{sym}: Position an der Börse nicht mehr vorhanden "
                                   f"({have} < {pos.amount}) – aus dem Zustand entfernt. Bitte Trade-Log prüfen.")
                self.positions.pop(sym)
        self.save_state()


def load_state(path: Path) -> dict:
    return read_json(path, {})
