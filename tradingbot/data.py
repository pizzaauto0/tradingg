"""Modul 1: Marktdaten (Live-Kurse und Historie) über ccxt."""
from __future__ import annotations

import logging
import time
from typing import Any

import ccxt
import pandas as pd

from .config import Config

log = logging.getLogger(__name__)

COLUMNS = ["open", "high", "low", "close", "volume"]


def rows_to_df(rows: list[list[float]]) -> pd.DataFrame:
    """ccxt-OHLCV-Zeilen -> DataFrame mit UTC-Zeitindex ('time')."""
    df = pd.DataFrame(rows, columns=["ts"] + COLUMNS)
    df["time"] = pd.to_datetime(df["ts"], unit="ms", utc=True)
    df = df.drop(columns="ts").set_index("time")
    df = df[~df.index.duplicated(keep="last")].sort_index()
    return df.astype(float)


class MarketData:
    """Öffentlicher Marktdatenzugriff (keine API-Keys nötig)."""

    def __init__(self, cfg: Config, exchange: Any = None, history_exchange: Any = None):
        self.cfg = cfg
        self.timeframe = cfg.market.timeframe
        self.tf_seconds = cfg.timeframe_seconds
        self.exchange = exchange or self._make_exchange(cfg.exchange.id)
        self._history_exchange = history_exchange
        self._markets_loaded = False

    @staticmethod
    def _make_exchange(exchange_id: str) -> Any:
        if not hasattr(ccxt, exchange_id):
            raise ValueError(f"Unbekannte ccxt-Börse: {exchange_id!r}")
        return getattr(ccxt, exchange_id)({"enableRateLimit": True})

    def _history_source(self) -> Any | None:
        if self._history_exchange is not None:
            return self._history_exchange
        hid = self.cfg.market.history_exchange
        if hid and hid != self.cfg.exchange.id:
            self._history_exchange = self._make_exchange(hid)
        return self._history_exchange

    @staticmethod
    def _retry(fn, *args, tries: int = 4):
        for attempt in range(tries):
            try:
                return fn(*args)
            except ccxt.NetworkError as exc:
                if attempt == tries - 1:
                    raise
                wait = 2 ** attempt
                log.warning("Netzwerkfehler (%s), neuer Versuch in %ss", exc, wait)
                time.sleep(wait)

    # ---------------------------------------------------------------- live
    def fetch_recent(self, symbol: str, limit: int | None = None) -> pd.DataFrame:
        """Letzte Kerzen (die letzte kann noch in Bildung sein)."""
        limit = limit or self.cfg.market.live_lookback
        rows = self._retry(self.exchange.fetch_ohlcv, symbol, self.timeframe, None, limit)
        if not rows:
            raise RuntimeError(f"Keine Kerzen für {symbol} erhalten.")
        return rows_to_df(rows)

    def fetch_price(self, symbol: str) -> float:
        ticker = self._retry(self.exchange.fetch_ticker, symbol)
        return float(ticker["last"])

    # ------------------------------------------------------------ historie
    def _paginate(self, ex: Any, symbol: str, n: int) -> pd.DataFrame:
        tf_ms = self.tf_seconds * 1000
        now_ms = int(time.time() * 1000)
        since = now_ms - n * tf_ms
        rows: list[list[float]] = []
        while since < now_ms:
            batch = self._retry(ex.fetch_ohlcv, symbol, self.timeframe, since, 1000)
            if not batch:
                break
            rows.extend(batch)
            last = batch[-1][0]
            if last + tf_ms <= since:  # kein Fortschritt
                break
            since = last + tf_ms
        if not rows:
            raise RuntimeError(f"Keine historischen Daten für {symbol}.")
        df = rows_to_df(rows)
        if df.index[-1].timestamp() * 1000 + tf_ms > now_ms:  # noch offene Kerze entfernen
            df = df.iloc[:-1]
        return df.tail(n)

    def fetch_history(self, symbol: str, n: int | None = None) -> pd.DataFrame:
        """Historische Kerzen; zuerst history_exchange, sonst die Hauptbörse."""
        n = n or self.cfg.market.history_candles
        sources = [s for s in (self._history_source(), self.exchange) if s is not None]
        best: pd.DataFrame | None = None
        for ex in sources:
            try:
                df = self._paginate(ex, symbol, n)
            except Exception as exc:  # noqa: BLE001 - nächste Quelle probieren
                log.warning("Historie von %s für %s fehlgeschlagen: %s", getattr(ex, "id", ex), symbol, exc)
                continue
            if best is None or len(df) > len(best):
                best = df
            if len(df) >= min(n, self.cfg.backtest.min_candles):
                return df
        if best is None:
            raise RuntimeError(f"Historie für {symbol} konnte von keiner Quelle geladen werden.")
        return best

    # ------------------------------------------------------ order-hilfen
    def normalize_amount(self, symbol: str, amount: float, price: float) -> float:
        """Rundet auf Börsenpräzision; 0.0, wenn Mindestmenge/-wert unterschritten wird."""
        try:
            if not self._markets_loaded:
                self._retry(self.exchange.load_markets)
                self._markets_loaded = True
            amt = float(self.exchange.amount_to_precision(symbol, amount))
            limits = self.exchange.market(symbol).get("limits", {})
        except Exception as exc:  # noqa: BLE001
            log.warning("Mengenrundung für %s nicht möglich: %s", symbol, exc)
            return 0.0
        min_amt = (limits.get("amount") or {}).get("min")
        min_cost = (limits.get("cost") or {}).get("min")
        if amt <= 0 or (min_amt and amt < min_amt) or (min_cost and amt * price < min_cost):
            return 0.0
        return amt
