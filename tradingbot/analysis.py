"""Modul 2: Marktanalyse – Indikatoren und Einordnung des Marktzustands."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

REGIMES = ("uptrend", "downtrend", "sideways")
MIN_CANDLES = 150
ADX_TREND = 22.0
EMA_FAST, EMA_SLOW, ADX_PERIOD = 20, 50, 14


# ------------------------------------------------------------- indikatoren
def sma(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n).mean()


def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False).mean()


def rsi(close: pd.Series, n: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    out = 100 - 100 / (1 + gain / loss)
    return out.where(loss != 0, 100.0)


def atr(df: pd.DataFrame, n: int = 14) -> pd.Series:
    prev_close = df["close"].shift(1)
    tr = pd.concat(
        [df["high"] - df["low"], (df["high"] - prev_close).abs(), (df["low"] - prev_close).abs()],
        axis=1,
    ).max(axis=1)
    return tr.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()


def bollinger(close: pd.Series, n: int = 20, k: float = 2.0) -> tuple[pd.Series, pd.Series, pd.Series]:
    mid = close.rolling(n).mean()
    std = close.rolling(n).std(ddof=0)
    return mid - k * std, mid, mid + k * std


def dmi(df: pd.DataFrame, n: int = 14) -> tuple[pd.Series, pd.Series, pd.Series]:
    """Directional Movement (Wilder): +DI, -DI und ADX."""
    up = df["high"].diff()
    down = -df["low"].diff()
    plus_dm = pd.Series(np.where((up > down) & (up > 0), up, 0.0), index=df.index)
    minus_dm = pd.Series(np.where((down > up) & (down > 0), down, 0.0), index=df.index)
    atr_ = atr(df, n)
    plus_di = 100 * plus_dm.ewm(alpha=1 / n, adjust=False, min_periods=n).mean() / atr_
    minus_di = 100 * minus_dm.ewm(alpha=1 / n, adjust=False, min_periods=n).mean() / atr_
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    return plus_di, minus_di, dx.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()


def adx(df: pd.DataFrame, n: int = 14) -> pd.Series:
    return dmi(df, n)[2]


def invert(df: pd.DataFrame) -> pd.DataFrame:
    """Kehrwert-Kurse (z. B. EUR/USD -> USD/EUR). Ein Long-Signal auf dem Kehrwert ist ein Short-Signal auf dem
    Original – so nutzen alle Strategien für Leerverkäufe exakt dieselbe Logik."""
    return pd.DataFrame({"open": 1 / df["open"], "high": 1 / df["low"], "low": 1 / df["high"],
                         "close": 1 / df["close"], "volume": df["volume"]}, index=df.index)


# ------------------------------------------------------------ marktzustand
def regime_series(df: pd.DataFrame) -> pd.Series:
    """Marktphase je Kerze (nur Vergangenheitsdaten): uptrend / downtrend / sideways."""
    close = df["close"]
    fast, slow, strength = ema(close, EMA_FAST), ema(close, EMA_SLOW), adx(df, ADX_PERIOD)
    up = (strength >= ADX_TREND) & (fast > slow) & (close > slow)
    down = (strength >= ADX_TREND) & (fast < slow) & (close < slow)
    out = pd.Series("sideways", index=df.index, dtype=object)
    out[up] = "uptrend"
    out[down] = "downtrend"
    return out


@dataclass(frozen=True)
class MarketState:
    regime: str          # uptrend / downtrend / sideways
    volatility: str      # low / normal / high
    volume: str          # low / normal / high
    adx: float
    atr_pct: float       # ATR in % vom Kurs
    ema_fast: float
    ema_slow: float
    close: float

    def summary(self) -> str:
        return (
            f"{self.regime} (ADX {self.adx:.1f}, EMA{EMA_FAST} {self.ema_fast:.2f} vs "
            f"EMA{EMA_SLOW} {self.ema_slow:.2f}), Volatilität {self.volatility} "
            f"(ATR {self.atr_pct:.2f}%), Volumen {self.volume}"
        )


def _level(ratio: float, low: float, high: float) -> str:
    if not np.isfinite(ratio):
        return "normal"
    return "high" if ratio > high else "low" if ratio < low else "normal"


def classify_market(df: pd.DataFrame) -> MarketState:
    """Ordnet die letzte Kerze von df ein. Für Live-Betrieb nur geschlossene Kerzen übergeben."""
    if len(df) < MIN_CANDLES:
        raise ValueError(f"Mindestens {MIN_CANDLES} Kerzen nötig, erhalten: {len(df)}")
    close = df["close"]
    regime = regime_series(df).iloc[-1]
    atr_pct = atr(df, 14) / close * 100
    vol_ratio = atr_pct.iloc[-1] / atr_pct.rolling(100).median().iloc[-1]
    vol_avg = df["volume"].rolling(50).mean().iloc[-1]
    volu_ratio = df["volume"].rolling(5).mean().iloc[-1] / vol_avg if vol_avg else np.nan
    return MarketState(
        regime=regime,
        volatility=_level(vol_ratio, 0.7, 1.5),
        volume=_level(volu_ratio, 0.6, 1.5),
        adx=float(adx(df, ADX_PERIOD).iloc[-1]),
        atr_pct=float(atr_pct.iloc[-1]),
        ema_fast=float(ema(close, EMA_FAST).iloc[-1]),
        ema_slow=float(ema(close, EMA_SLOW).iloc[-1]),
        close=float(close.iloc[-1]),
    )
