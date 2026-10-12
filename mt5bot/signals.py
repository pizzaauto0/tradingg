"""Signal-Logik der Profile. Reine pandas-Module ohne MT5-Abhängigkeit (deshalb ohne Terminal testbar).

Schnittstelle jeder Strategie (auf GESCHLOSSENEN Kerzen):
  entry(df, extra) -> "long" | "short" | None
  exit(df, direction, extra) -> bool
  status(df, extra) -> str            (Textzeile für das Log)
  needs: Liste weiterer Symbole (Referenzmärkte), die zusätzlich geladen werden
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from tradingbot.analysis import atr, invert, regime_series
from tradingbot.strategies import build_strategy


def atr_last(df: pd.DataFrame, n: int = 14) -> float:
    v = atr(df, n).iloc[-1]
    return float(v) if np.isfinite(v) else float("nan")


class LibraryStrategy:
    """Jede Strategie aus tradingbot/strategies.py (dieselbe Logik wie im Backtest und in den Massen-Tests)."""
    needs: list[str] = []

    def __init__(self, spec: dict, allow_short: bool = False):
        self.strat = build_strategy({"type": spec["type"], "params": spec.get("params", {})})
        self.allow_short = allow_short
        self.min_bars = 260

    @property
    def name(self) -> str:
        return self.strat.name

    def _frames(self, df):
        return df, (invert(df) if self.allow_short else None)

    def entry(self, df, extra=None):
        if len(df) < self.min_bars:
            return None
        long_df, short_df = self._frames(df)
        if bool(self.strat.entry(long_df).iloc[-1]) and bool(regime_series(long_df).isin(self.strat.regimes).iloc[-1]):
            return "long"
        if short_df is not None and bool(self.strat.entry(short_df).iloc[-1]) and bool(regime_series(short_df).isin(self.strat.regimes).iloc[-1]):
            return "short"
        return None

    def exit(self, df, direction, extra=None):
        if len(df) < self.min_bars:
            return False
        d = df if direction == "long" else invert(df)
        return bool(self.strat.exit(d).iloc[-1])

    def status(self, df, extra=None):
        if len(df) < self.min_bars:
            return "warte auf genug Kerzen"
        sig = self.entry(df)
        regime = regime_series(df).iloc[-1]
        return f"Marktphase {regime} | Signal: {sig or 'keins'}"


class RsiPullback:
    """Strategie der Beispiel-Bots 1 und 2: Kurs über der Trend-EMA (bzw. darunter für Short, mit Neutralzone um die EMA),
    RSI kreuzt von unten über die Überverkauft-Schwelle (Short: von oben unter 100 - Schwelle)."""
    needs: list[str] = []

    def __init__(self, spec: dict, allow_short: bool = False):
        p = spec.get("params", {})
        self.trend_len, self.rsi_len = int(p.get("trend_len", 150)), int(p.get("rsi_len", 14))
        self.oversold, self.buffer = float(p.get("oversold", 35)), float(p.get("buffer_atr", 0.0))
        if allow_short and self.oversold >= 50:
            raise ValueError("oversold muss unter 50 liegen, wenn Short aktiv ist")
        self.allow_short = allow_short
        self.min_bars = self.trend_len * 2 + 5  # EMA braucht das 2- bis 3-fache ihrer Länge, um eingeschwungen zu sein

    @property
    def name(self) -> str:
        return f"rsi_pullback(ema={self.trend_len},rsi={self.rsi_len}@{self.oversold:g},buf={self.buffer:g})"

    def _calc(self, df):
        c = df["close"]
        ema = c.ewm(span=self.trend_len, adjust=False).mean()
        delta = c.diff()
        gain, loss = delta.clip(lower=0.0), (-delta).clip(lower=0.0)
        ag, al = gain.ewm(alpha=1 / self.rsi_len, adjust=False).mean(), loss.ewm(alpha=1 / self.rsi_len, adjust=False).mean()
        rs = ag / al.where(al > 0)
        rsi = (100 - 100 / (1 + rs)).mask((al == 0) & (ag > 0), 100.0).mask((al == 0) & (ag == 0), 50.0)
        return c, ema, rsi, atr(df, 14)

    def entry(self, df, extra=None):
        if len(df) < self.min_bars:
            return None
        c, ema, rsi, a = self._calc(df)
        if not np.isfinite([c.iloc[-1], ema.iloc[-1], rsi.iloc[-1], rsi.iloc[-2], a.iloc[-1]]).all():
            return None
        buf = a.iloc[-1] * self.buffer
        if c.iloc[-1] > ema.iloc[-1] + buf and rsi.iloc[-2] <= self.oversold < rsi.iloc[-1]:
            return "long"
        ob = 100.0 - self.oversold
        if self.allow_short and c.iloc[-1] < ema.iloc[-1] - buf and rsi.iloc[-2] >= ob > rsi.iloc[-1]:
            return "short"
        return None

    def exit(self, df, direction, extra=None):
        return False  # Ausstieg nur über Stop-Loss / Take-Profit (wie bei den Beispiel-Bots)

    def status(self, df, extra=None):
        if len(df) < self.min_bars:
            return "warte auf genug Kerzen"
        c, ema, rsi, a = self._calc(df)
        trend = "Aufwärts" if c.iloc[-1] > ema.iloc[-1] else "Abwärts"
        return f"Trend {trend} | RSI {rsi.iloc[-1]:.0f} (Signal bei Kreuz über {self.oversold:g})"


class GoldSilverDivergence:
    """Strategie des Beispiel-Bots 3: Differenz der N-Kerzen-Renditen von Gold und Silber fällt unter ein -k-Sigma-Band und
    kreuzt zurück darüber (Gold holt auf), bei Kurs über der Trend-EMA. Braucht zusätzlich die Silber-Kerzen."""

    def __init__(self, spec: dict, allow_short: bool = False):
        p = spec.get("params", {})
        self.ref = p.get("reference", "XAGUSD")
        self.trend_len, self.ret_len = int(p.get("trend_len", 150)), int(p.get("ret_len", 20))
        self.lookback, self.mult = int(p.get("band_lookback", 100)), float(p.get("band_mult", 1.5))
        self.needs = [self.ref]
        self.min_bars = max(self.trend_len, self.ret_len + self.lookback) + 5

    @property
    def name(self) -> str:
        return f"gold_silver_divergence(ret={self.ret_len},band={self.mult:g}σ/{self.lookback})"

    def _diff_band(self, x: pd.DataFrame, y: pd.DataFrame):
        y_on_x = y["close"].reindex(x.index, method="ffill")  # letzter bekannter Silberkurs auf oder vor dem Gold-Zeitstempel
        if y_on_x.isna().all():
            return None, None
        d = (x["close"] / x["close"].shift(self.ret_len) - 1.0) - (y_on_x / y_on_x.shift(self.ret_len) - 1.0)
        mean, std = d.rolling(self.lookback, min_periods=self.lookback).mean(), d.rolling(self.lookback, min_periods=self.lookback).std()
        return d, mean - self.mult * std

    def entry(self, df, extra=None):
        ref = (extra or {}).get(self.ref)
        if ref is None or len(df) < self.min_bars or len(ref) < self.min_bars:
            return None
        d, band = self._diff_band(df, ref)
        if d is None or d.iloc[-2:].isna().any() or band.iloc[-2:].isna().any():
            return None
        crossed = (d.iloc[-2] <= band.iloc[-2]) and not (d.iloc[-1] <= band.iloc[-1])
        up = df["close"].iloc[-1] > df["close"].ewm(span=self.trend_len, adjust=False).mean().iloc[-1]
        return "long" if crossed and up else None

    def exit(self, df, direction, extra=None):
        return False

    def status(self, df, extra=None):
        ref = (extra or {}).get(self.ref)
        if ref is None or len(df) < self.min_bars or len(ref) < self.min_bars:
            return "warte auf genug Kerzen (Gold und Silber)"
        d, band = self._diff_band(df, ref)
        if d is None or pd.isna(d.iloc[-1]) or pd.isna(band.iloc[-1]):
            return "keine Daten"
        return f"Differenz {d.iloc[-1]:+.4f} | Band {band.iloc[-1]:+.4f} | {'UNTER dem Band (bereit)' if d.iloc[-1] <= band.iloc[-1] else 'über dem Band'}"


def make_strategy(spec: dict, allow_short: bool):
    t = spec["type"]
    if t == "rsi_pullback":
        return RsiPullback(spec, allow_short)
    if t == "gold_silver_divergence":
        return GoldSilverDivergence(spec, allow_short)
    return LibraryStrategy(spec, allow_short)
