"""Forex über Interactive Brokers (ib_async). TWS oder IB Gateway muss laufen und eingeloggt sein.

- Marktdaten: Mittelkurse (MIDPOINT) aus der IB-Historie, auch im Paper-Modus nötig.
- Orders: Bracket-Order – Markt-Einstieg mit Stop-Loss UND Take-Profit direkt beim Broker (OCA: eine Seite
  storniert die andere). Die Position bleibt so auch geschützt, wenn der Bot ausfällt.
- Sicherheit: Bei ibkr.account_type = "paper" verweigert der Bot jedes Konto, das kein IB-Paper-Konto ist
  (Paper-Konten beginnen mit "DU").
"""
from __future__ import annotations

import logging
import math
import time
from typing import Any, Optional

import pandas as pd

from .config import Config, ConfigError
from .execution import Fill, Position, StopOrderLost

log = logging.getLogger(__name__)

BAR_SIZE = {"5m": "5 mins", "15m": "15 mins", "30m": "30 mins", "1h": "1 hour"}


def connect(cfg: Config) -> Any:
    from ib_async import IB

    ib = IB()
    ib.connect(cfg.ibkr.host, cfg.ibkr.port, clientId=cfg.ibkr.client_id, timeout=20)
    return ib


def pair_code(symbol: str) -> str:
    return symbol.replace("/", "")


def round_price(symbol: str, price: float) -> float:
    """Auf das Kursraster von IDEALPRO runden (JPY-Paare 0.005, sonst 0.00005)."""
    tick = 0.005 if symbol.endswith("JPY") else 0.00005
    return round(round(price / tick) * tick, 3 if symbol.endswith("JPY") else 5)


class IBMarketData:
    """Kerzen und Kurse von IB (gleiche Schnittstelle wie data.MarketData)."""

    def __init__(self, cfg: Config, ib: Any):
        self.cfg = cfg
        self.ib = ib
        self.tf_seconds = cfg.timeframe_seconds
        self._contracts: dict[str, Any] = {}

    def contract(self, symbol: str) -> Any:
        if symbol not in self._contracts:
            from ib_async import Forex

            c = Forex(pair_code(symbol))
            self.ib.qualifyContracts(c)
            self._contracts[symbol] = c
        return self._contracts[symbol]

    def _bars(self, symbol: str, end: Any, duration: str) -> list:
        return self.ib.reqHistoricalData(self.contract(symbol), endDateTime=end, durationStr=duration,
                                         barSizeSetting=BAR_SIZE[self.cfg.market.timeframe], whatToShow="MIDPOINT",
                                         useRTH=False, formatDate=2)

    @staticmethod
    def _to_df(bars: list) -> pd.DataFrame:
        rows = [{"time": pd.Timestamp(b.date).tz_convert("UTC") if pd.Timestamp(b.date).tzinfo else pd.Timestamp(b.date, tz="UTC"),
                 "open": float(b.open), "high": float(b.high), "low": float(b.low), "close": float(b.close),
                 "volume": max(float(b.volume or 0), 0.0)} for b in bars]
        if not rows:
            return pd.DataFrame(columns=["open", "high", "low", "close", "volume"])
        df = pd.DataFrame(rows).set_index("time").sort_index()
        return df[~df.index.duplicated(keep="last")]

    def fetch_recent(self, symbol: str, limit: Optional[int] = None) -> pd.DataFrame:
        n = limit or self.cfg.market.live_lookback
        days = math.ceil(n * self.tf_seconds / 86400 * 1.6) + 2  # Wochenenden einrechnen
        df = self._to_df(self._bars(symbol, "", f"{days} D"))
        if df.empty:
            raise RuntimeError(f"Keine Kerzen für {symbol} von IB erhalten")
        return df.tail(n)

    def fetch_history(self, symbol: str, n: Optional[int] = None) -> pd.DataFrame:
        n = n or self.cfg.market.history_candles
        frames, end = [], ""
        for _ in range(60):  # in 5-Tages-Stücken rückwärts laden (IB-Abfragegrenzen)
            bars = self._bars(symbol, end, "5 D")
            if not bars:
                break
            frames.insert(0, self._to_df(bars))
            if sum(len(f) for f in frames) >= n:
                break
            end = bars[0].date
        if not frames:
            raise RuntimeError(f"Keine Historie für {symbol} von IB erhalten")
        df = pd.concat(frames).sort_index()
        df = df[~df.index.duplicated(keep="last")]
        if df.index[-1].timestamp() + self.tf_seconds > time.time():  # offene Kerze entfernen
            df = df.iloc[:-1]
        return df.tail(n)

    def fetch_price(self, symbol: str) -> float:
        return float(self.fetch_recent(symbol, 5)["close"].iloc[-1])

    def normalize_amount(self, symbol: str, amount: float, price: float) -> float:
        """Forex-Einheiten sind ganze Zahlen. (Unter 25.000 Einheiten führt IB 'Odd Lots' mit etwas schlechterem Kurs aus.)"""
        units = math.floor(amount)
        return float(units) if units >= 1 else 0.0


class IBKRBroker:
    """Echte (oder IB-Paper-)Orders bei Interactive Brokers – Margin-Konto mit Long und Short."""

    mode = "live"
    manages_take_profit = True  # Take-Profit liegt als Order beim Broker

    def __init__(self, cfg: Config, ib: Any, data: IBMarketData):
        self.cfg = cfg
        self.ib = ib
        self.data = data
        accounts = list(ib.managedAccounts())
        self.account = cfg.ibkr.account or (accounts[0] if accounts else "")
        if not self.account:
            raise ConfigError("Kein IB-Konto gefunden – ist TWS/IB Gateway eingeloggt?")
        if cfg.ibkr.account_type == "paper" and not self.account.startswith("DU"):
            raise ConfigError(f"ibkr.account_type ist 'paper', aber das verbundene Konto {self.account} ist kein "
                              f"Paper-Konto. Zum Schutz wird nicht gehandelt.")
        self.account_ccy = self._summary("NetLiquidation")[1]
        self._rates: dict[str, tuple[float, float]] = {}

    def _summary(self, tag: str) -> tuple[float, str]:
        for v in self.ib.accountSummary(self.account):
            if v.tag == tag and v.currency not in ("", "BASE"):
                return float(v.value), v.currency
        raise RuntimeError(f"Kontowert {tag} nicht verfügbar")

    def sleep(self, seconds: float) -> None:
        self.ib.sleep(seconds)

    # ---- Kontowerte
    def cash(self) -> float:
        return self._summary("NetLiquidation")[0]

    def equity_value(self, positions: dict[str, Position], prices: dict[str, float]) -> float:
        return self._summary("NetLiquidation")[0]

    def to_quote(self, symbol: str, value: float) -> float:
        """Kontowährung -> Quote-Währung des Paares (Positionsgröße wird in der Quote-Währung berechnet)."""
        quote = symbol.split("/")[1]
        if quote == self.account_ccy:
            return value
        cached = self._rates.get(quote)
        if cached and time.time() - cached[1] < 300:
            return value * cached[0]
        try:
            rate = self.data.fetch_price(f"{self.account_ccy}/{quote}")
        except Exception:  # noqa: BLE001 - Paar existiert nur andersherum
            rate = 1 / self.data.fetch_price(f"{quote}/{self.account_ccy}")
        self._rates[quote] = (rate, time.time())
        return value * rate

    def base_balance(self, symbol: str) -> float:
        code = pair_code(symbol)
        for p in self.ib.positions(self.account):
            if p.contract.symbol + p.contract.currency == code:
                return abs(float(p.position))
        return 0.0

    # ---- Orders
    def _wait(self, trade: Any, timeout: float = 30) -> bool:
        deadline = time.time() + timeout
        while not trade.isDone() and time.time() < deadline:
            self.ib.sleep(0.5)
        return trade.orderStatus.status == "Filled"

    @staticmethod
    def _commission(trade: Any) -> float:
        return float(sum((f.commissionReport.commission or 0) for f in trade.fills if f.commissionReport))

    def _find(self, order_id: Optional[str]) -> Any:
        if not order_id:
            return None
        for t in self.ib.trades():
            if str(t.order.orderId) == str(order_id):
                return t
        return None

    def open_position(self, symbol: str, side: int, amount: float, stop: float, take_profit: float,
                      ref_price: float) -> Fill:
        from ib_async import LimitOrder, MarketOrder, StopOrder

        contract = self.data.contract(symbol)
        qty = int(amount)
        action, reverse = ("BUY", "SELL") if side == 1 else ("SELL", "BUY")
        parent = MarketOrder(action, qty, orderId=self.ib.client.getReqId(), transmit=False, account=self.account)
        oca = f"bot-{parent.orderId}"
        tp = LimitOrder(reverse, qty, round_price(symbol, take_profit), orderId=self.ib.client.getReqId(),
                        parentId=parent.orderId, transmit=False, ocaGroup=oca, ocaType=1, tif="GTC", account=self.account)
        sl = StopOrder(reverse, qty, round_price(symbol, stop), orderId=self.ib.client.getReqId(),
                       parentId=parent.orderId, transmit=True, ocaGroup=oca, ocaType=1, tif="GTC", account=self.account)
        trades = [self.ib.placeOrder(contract, o) for o in (parent, tp, sl)]  # transmit erst mit dem letzten Kind
        if not self._wait(trades[0]):
            for t in trades:
                self.ib.cancelOrder(t.order)
            raise RuntimeError(f"Einstiegsorder {parent.orderId} für {symbol} nicht ausgeführt "
                               f"({trades[0].orderStatus.status}) – storniert")
        st = trades[0].orderStatus
        return Fill(float(st.avgFillPrice), float(st.filled), self._commission(trades[0]), order_id=str(parent.orderId),
                    stop_order_id=str(sl.orderId), tp_order_id=str(tp.orderId))

    def check_stop(self, pos: Position, extreme_since_entry: float, last_price: float) -> Optional[Fill]:
        """Fragt beim Broker nach, ob Stop-Loss oder Take-Profit ausgeführt wurden."""
        sl, tp = self._find(pos.stop_order_id), self._find(pos.tp_order_id)
        if sl is None or tp is None:  # z. B. nach einem Neustart: alle offenen Orders beim Broker abfragen
            self.ib.reqAllOpenOrders()
            sl, tp = self._find(pos.stop_order_id), self._find(pos.tp_order_id)
        for t, why in ((sl, "Stop-Loss (beim Broker ausgeführt)"), (tp, "Take-Profit (beim Broker ausgeführt)")):
            if t is not None and t.orderStatus.status == "Filled":
                return Fill(float(t.orderStatus.avgFillPrice), float(t.orderStatus.filled), self._commission(t),
                            order_id=str(t.order.orderId), reason=why)
        if (sl is None or sl.isDone()) and self.base_balance(pos.symbol) > 0:
            raise StopOrderLost("Stop-Order beim Broker nicht mehr aktiv")
        return None

    def close_position(self, pos: Position, ref_price: float) -> Fill:
        from ib_async import MarketOrder

        for oid in (pos.stop_order_id, pos.tp_order_id):
            t = self._find(oid)
            if t is not None and not t.isDone():
                self.ib.cancelOrder(t.order)
        qty = int(self.base_balance(pos.symbol) or pos.amount)
        action = "SELL" if pos.side == 1 else "BUY"
        trade = self.ib.placeOrder(self.data.contract(pos.symbol), MarketOrder(action, qty, account=self.account))
        if not self._wait(trade):
            raise RuntimeError(f"Schließen von {pos.symbol} nicht bestätigt – bitte in TWS prüfen!")
        st = trade.orderStatus
        return Fill(float(st.avgFillPrice), float(st.filled), self._commission(trade), order_id=str(trade.order.orderId))
