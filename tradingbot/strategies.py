"""Strategie-Bibliothek: 25 bekannte Strategien mit festen, validierten Parametern.

Jede Strategie liefert Einstiegs- und Ausstiegssignale für Long-Positionen am Schluss einer Kerze (nur
Vergangenheitsdaten). Short-Signale entstehen automatisch, indem dieselbe Logik auf die Kehrwert-Kurse angewendet
wird (siehe analysis.invert) – genutzt nur, wo Leerverkäufe erlaubt sind (Forex).

Optional kann jede Strategie eigene Ausstiegsabstände haben: stop_mult (Stop = x * ATR) und rr (Ziel = rr * Risiko).
Das beeinflusst die Trefferquote stark (nahes Ziel = hohe Trefferquote, aber kleine Gewinne).

Auch LLM-Vorschläge werden nur als Spezifikation {"type", "params", "regimes"} akzeptiert und gegen die Grenzen
geprüft – es wird niemals generierter Code ausgeführt. Jede Strategie muss den Backtest bestehen.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

import numpy as np
import pandas as pd

from .analysis import REGIMES, atr, bollinger, dmi, ema, invert, rsi

# Optionale Ausstiegsparameter, die jede Strategie haben darf: Name -> (Typ, Minimum, Maximum)
EXIT_SPEC: dict[str, tuple[type, float, float]] = {"stop_mult": (float, 0.5, 5.0), "rr": (float, 0.5, 5.0)}


def sma(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n).mean()


def _cross_up(a: pd.Series, b: pd.Series) -> pd.Series:
    return (a > b) & (a.shift(1) <= b.shift(1))


class Strategy(ABC):
    type_name: str = ""
    default_regimes: tuple[str, ...] = ()
    param_spec: dict[str, tuple[type, float, float]] = {}
    description: str = ""
    source: str = ""

    def __init__(self, regimes: tuple[str, ...] | list[str] | None = None, **params: Any):
        exits = {k: params.pop(k) for k in list(params) if k in EXIT_SPEC}
        unknown = set(params) - set(self.param_spec)
        missing = set(self.param_spec) - set(params)
        if unknown or missing:
            raise ValueError(f"{self.type_name}: unbekannte Parameter {sorted(unknown)}, fehlend {sorted(missing)}")
        self.params = self._validate(params, self.param_spec)
        self.exits = self._validate({k: v for k, v in exits.items() if v is not None},
                                    {k: EXIT_SPEC[k] for k in exits if exits[k] is not None})
        self.regimes = tuple(regimes) if regimes else self.default_regimes
        bad = [r for r in self.regimes if r not in REGIMES]
        if bad or not self.regimes:
            raise ValueError(f"{self.type_name}: ungültige Marktphasen {bad or self.regimes}")
        self._check()

    def _validate(self, params: dict[str, Any], spec: dict[str, tuple[type, float, float]]) -> dict[str, Any]:
        clean: dict[str, Any] = {}
        for key, (typ, lo, hi) in spec.items():
            try:
                value = typ(params[key])
            except (TypeError, ValueError) as exc:
                raise ValueError(f"{self.type_name}.{key}: ungültiger Wert {params[key]!r}") from exc
            if not lo <= value <= hi:
                raise ValueError(f"{self.type_name}.{key}={value} außerhalb [{lo}, {hi}]")
            clean[key] = value
        return clean

    def _check(self) -> None:
        """Zusätzliche Konsistenzprüfungen der Parameter."""

    @property
    def name(self) -> str:
        args = ",".join(f"{k}={v}" for k, v in {**self.params, **self.exits}.items())
        return f"{self.type_name}({args})"

    def to_spec(self) -> dict[str, Any]:
        return {"type": self.type_name, "params": {**self.params, **self.exits}, "regimes": list(self.regimes)}

    def stop_mult(self, default: float) -> float:
        return self.exits.get("stop_mult", default)

    def rr(self, default: float) -> float:
        return self.exits.get("rr", default)

    def entry_short(self, df: pd.DataFrame) -> pd.Series:
        return self.entry(invert(df))

    def exit_short(self, df: pd.DataFrame) -> pd.Series:
        return self.exit(invert(df))

    @abstractmethod
    def entry(self, df: pd.DataFrame) -> pd.Series:
        """Bool-Serie: Long-Einstiegssignal am Schluss der jeweiligen Kerze."""

    @abstractmethod
    def exit(self, df: pd.DataFrame) -> pd.Series:
        """Bool-Serie: Long-Ausstiegssignal am Schluss der jeweiligen Kerze."""

    def explain(self, df: pd.DataFrame) -> str:
        """Begründung fürs Trade-Log."""
        return f"{self.name}: Einstiegssignal ({self.description})"


# =============================================================== Trendfolge
class MACrossover(Strategy):
    type_name = "ma_crossover"
    default_regimes = ("uptrend",)
    param_spec = {"fast": (int, 3, 50), "slow": (int, 10, 200)}
    description = "Schnelle EMA kreuzt langsame EMA nach oben; Ausstieg bei Gegenkreuzung."
    source = "Klassische Trendfolge (z. B. Murphy, Technical Analysis of the Financial Markets)"

    def _check(self):
        if self.params["fast"] >= self.params["slow"]:
            raise ValueError("ma_crossover: fast muss kleiner als slow sein")

    def entry(self, df):
        return _cross_up(ema(df["close"], self.params["fast"]), ema(df["close"], self.params["slow"]))

    def exit(self, df):
        return ema(df["close"], self.params["fast"]) < ema(df["close"], self.params["slow"])


class TripleEMA(Strategy):
    type_name = "triple_ema"
    default_regimes = ("uptrend",)
    param_spec = {"fast": (int, 3, 30), "mid": (int, 10, 80), "slow": (int, 30, 250)}
    description = "Drei EMAs ordnen sich bullisch (schnell > mittel > langsam); Ausstieg, wenn schnell < mittel."
    source = "Trendfolge mit EMA-Ausrichtung (u. a. Elder, Triple Screen)"

    def _check(self):
        if not self.params["fast"] < self.params["mid"] < self.params["slow"]:
            raise ValueError("triple_ema: fast < mid < slow erforderlich")

    def entry(self, df):
        c = df["close"]
        a, b, d = ema(c, self.params["fast"]), ema(c, self.params["mid"]), ema(c, self.params["slow"])
        aligned = (a > b) & (b > d)
        return aligned & ~aligned.shift(1, fill_value=False)

    def exit(self, df):
        return ema(df["close"], self.params["fast"]) < ema(df["close"], self.params["mid"])


class MACDCross(Strategy):
    type_name = "macd_cross"
    default_regimes = ("uptrend",)
    param_spec = {"fast": (int, 5, 20), "slow": (int, 15, 50), "signal": (int, 5, 15)}
    description = "MACD kreuzt seine Signallinie nach oben; Ausstieg bei Gegenkreuzung."
    source = "Gerald Appel (1970er), MACD"

    def _check(self):
        if self.params["fast"] >= self.params["slow"]:
            raise ValueError("macd_cross: fast muss kleiner als slow sein")

    def _macd(self, df):
        m = ema(df["close"], self.params["fast"]) - ema(df["close"], self.params["slow"])
        return m, ema(m, self.params["signal"])

    def entry(self, df):
        m, s = self._macd(df)
        return _cross_up(m, s)

    def exit(self, df):
        m, s = self._macd(df)
        return m < s


class MACDZero(Strategy):
    type_name = "macd_zero"
    default_regimes = ("uptrend",)
    param_spec = {"fast": (int, 5, 20), "slow": (int, 15, 50)}
    description = "MACD-Linie kreuzt die Nulllinie nach oben; Ausstieg unter null."
    source = "Gerald Appel, MACD-Nulllinie"

    def _check(self):
        if self.params["fast"] >= self.params["slow"]:
            raise ValueError("macd_zero: fast muss kleiner als slow sein")

    def _m(self, df):
        return ema(df["close"], self.params["fast"]) - ema(df["close"], self.params["slow"])

    def entry(self, df):
        m = self._m(df)
        return (m > 0) & (m.shift(1) <= 0)

    def exit(self, df):
        return self._m(df) < 0


class ADXTrend(Strategy):
    type_name = "adx_di"
    default_regimes = ("uptrend",)
    param_spec = {"period": (int, 7, 30), "threshold": (float, 15, 40)}
    description = "+DI kreuzt -DI nach oben bei starkem Trend (ADX über Schwelle); Ausstieg, wenn -DI > +DI."
    source = "J. Welles Wilder, New Concepts in Technical Trading Systems (1978)"

    def entry(self, df):
        p, m, a = dmi(df, self.params["period"])
        return _cross_up(p, m) & (a > self.params["threshold"])

    def exit(self, df):
        p, m, _ = dmi(df, self.params["period"])
        return m > p


def supertrend_direction(df: pd.DataFrame, n: int, mult: float) -> np.ndarray:
    h, l, c = (df[k].to_numpy() for k in ("high", "low", "close"))
    a = atr(df, n).to_numpy()
    hl2 = (h + l) / 2
    ub, lb = hl2 + mult * a, hl2 - mult * a
    out = np.full(len(c), np.nan)
    fub = flb = np.nan
    cur = 0
    for i in range(len(c)):
        if not np.isfinite(a[i]):
            continue
        if not np.isfinite(fub):
            fub, flb = ub[i], lb[i]
            cur = 1 if c[i] >= hl2[i] else -1
            out[i] = cur
            continue
        pub, plb = fub, flb
        fub = ub[i] if (ub[i] < pub or c[i - 1] > pub) else pub
        flb = lb[i] if (lb[i] > plb or c[i - 1] < plb) else plb
        if cur == -1 and c[i] > pub:
            cur = 1
        elif cur == 1 and c[i] < plb:
            cur = -1
        out[i] = cur
    return out


class Supertrend(Strategy):
    type_name = "supertrend"
    default_regimes = ("uptrend",)
    param_spec = {"period": (int, 7, 30), "mult": (float, 1.0, 5.0)}
    description = "Supertrend (ATR-Band) dreht auf aufwärts; Ausstieg, wenn er auf abwärts dreht."
    source = "Olivier Seban, Supertrend-Indikator"

    def entry(self, df):
        d = pd.Series(supertrend_direction(df, self.params["period"], self.params["mult"]), index=df.index)
        return (d == 1) & (d.shift(1) == -1)

    def exit(self, df):
        return pd.Series(supertrend_direction(df, self.params["period"], self.params["mult"]) == -1, index=df.index)


def psar_direction(df: pd.DataFrame, step: float, max_af: float) -> np.ndarray:
    h, l, c = (df[k].to_numpy() for k in ("high", "low", "close"))
    n = len(c)
    out = np.full(n, np.nan)
    if n < 3:
        return out
    up = c[1] >= c[0]
    sar = l[0] if up else h[0]
    ep = h[1] if up else l[1]
    af = step
    out[1] = 1 if up else -1
    for i in range(2, n):
        sar = sar + af * (ep - sar)
        if up:
            sar = min(sar, l[i - 1], l[i - 2])
            if l[i] < sar:
                up, sar, ep, af = False, ep, l[i], step
            elif h[i] > ep:
                ep, af = h[i], min(af + step, max_af)
        else:
            sar = max(sar, h[i - 1], h[i - 2])
            if h[i] > sar:
                up, sar, ep, af = True, ep, h[i], step
            elif l[i] < ep:
                ep, af = l[i], min(af + step, max_af)
        out[i] = 1 if up else -1
    return out


class ParabolicSAR(Strategy):
    type_name = "parabolic_sar"
    default_regimes = ("uptrend",)
    param_spec = {"step": (float, 0.01, 0.05), "max_af": (float, 0.1, 0.4)}
    description = "Parabolic SAR wechselt unter den Kurs (Aufwärtstrend); Ausstieg beim Wechsel darüber."
    source = "J. Welles Wilder (1978)"

    def entry(self, df):
        d = pd.Series(psar_direction(df, self.params["step"], self.params["max_af"]), index=df.index)
        return (d == 1) & (d.shift(1) == -1)

    def exit(self, df):
        return pd.Series(psar_direction(df, self.params["step"], self.params["max_af"]) == -1, index=df.index)


class Ichimoku(Strategy):
    type_name = "ichimoku"
    default_regimes = ("uptrend",)
    param_spec = {"tenkan": (int, 5, 20), "kijun": (int, 20, 60), "senkou_b": (int, 40, 120)}
    description = "Tenkan kreuzt Kijun nach oben, Kurs über der Wolke; Ausstieg, wenn Tenkan < Kijun."
    source = "Goichi Hosoda, Ichimoku Kinko Hyo"

    def _check(self):
        if not self.params["tenkan"] < self.params["kijun"] < self.params["senkou_b"]:
            raise ValueError("ichimoku: tenkan < kijun < senkou_b erforderlich")

    def _lines(self, df):
        mid = lambda n: (df["high"].rolling(n).max() + df["low"].rolling(n).min()) / 2  # noqa: E731
        t, k = mid(self.params["tenkan"]), mid(self.params["kijun"])
        span_a = ((t + k) / 2).shift(self.params["kijun"])
        span_b = mid(self.params["senkou_b"]).shift(self.params["kijun"])
        return t, k, pd.Series(np.maximum(span_a.to_numpy(), span_b.to_numpy()), index=df.index)

    def entry(self, df):
        t, k, top = self._lines(df)
        return _cross_up(t, k) & (df["close"] > top)

    def exit(self, df):
        t, k, _ = self._lines(df)
        return t < k


class HeikinAshi(Strategy):
    type_name = "heikin_ashi"
    default_regimes = ("uptrend",)
    param_spec = {"bars": (int, 1, 5)}
    description = "N bullische Heikin-Ashi-Kerzen in Folge; Ausstieg bei der ersten bärischen."
    source = "Heikin-Ashi (japanische Kerzentechnik), u. a. Dan Valcu"

    @staticmethod
    def _bull(df):
        o, h, l, c = (df[k].to_numpy() for k in ("open", "high", "low", "close"))
        hc = (o + h + l + c) / 4
        ho = np.empty(len(c))
        if len(c):
            ho[0] = (o[0] + c[0]) / 2
        for i in range(1, len(c)):
            ho[i] = (ho[i - 1] + hc[i - 1]) / 2
        return hc > ho

    def entry(self, df):
        bull = self._bull(df)
        streak = np.zeros(len(bull), dtype=int)
        for i in range(len(bull)):
            streak[i] = (streak[i - 1] + 1 if i else 1) if bull[i] else 0
        return pd.Series(streak == self.params["bars"], index=df.index)

    def exit(self, df):
        return pd.Series(~self._bull(df), index=df.index)


class ROCMomentum(Strategy):
    type_name = "roc_momentum"
    default_regimes = ("uptrend",)
    param_spec = {"period": (int, 5, 50), "threshold": (float, 0.0, 5.0)}
    description = "Kursänderung über N Kerzen (Rate of Change) steigt über eine Schwelle; Ausstieg, wenn sie negativ wird."
    source = "Momentum-/ROC-Strategie (u. a. Jegadeesh & Titman zu Momentum)"

    def _roc(self, df):
        return (df["close"] / df["close"].shift(self.params["period"]) - 1) * 100

    def entry(self, df):
        r = self._roc(df)
        return (r > self.params["threshold"]) & (r.shift(1) <= self.params["threshold"])

    def exit(self, df):
        return self._roc(df) < 0


# =============================================================== Ausbrüche
class Breakout(Strategy):
    type_name = "breakout"
    default_regimes = ("uptrend",)
    param_spec = {"lookback": (int, 10, 200), "exit_lookback": (int, 5, 100)}
    description = "Ausbruch über das Hoch der letzten N Kerzen; Ausstieg unter dem Tief der letzten M Kerzen (Donchian)."
    source = "Richard Donchian / Turtle-Trader (Dennis & Eckhardt)"

    def _check(self):
        if self.params["exit_lookback"] > self.params["lookback"]:
            raise ValueError("breakout: exit_lookback darf lookback nicht überschreiten")

    def entry(self, df):
        return df["close"] > df["high"].rolling(self.params["lookback"]).max().shift(1)

    def exit(self, df):
        return df["close"] < df["low"].rolling(self.params["exit_lookback"]).min().shift(1)


class SqueezeBreakout(Strategy):
    type_name = "squeeze_breakout"
    default_regimes = ("uptrend", "sideways")
    param_spec = {"period": (int, 10, 40), "bb_mult": (float, 1.5, 3.0), "kc_mult": (float, 1.0, 2.5)}
    description = "Bollinger-Bänder lagen innerhalb der Keltner-Kanäle (Squeeze) und öffnen sich mit Kurs über der Mitte."
    source = "John Carter, TTM Squeeze (Mastering the Trade)"

    def entry(self, df):
        c, n = df["close"], self.params["period"]
        mid = sma(c, n)
        sd = c.rolling(n).std(ddof=0)
        km, a = ema(c, n), atr(df, n)
        on = ((mid + self.params["bb_mult"] * sd) < (km + self.params["kc_mult"] * a)) & \
             ((mid - self.params["bb_mult"] * sd) > (km - self.params["kc_mult"] * a))
        return on.shift(1, fill_value=False) & ~on & (c > mid)

    def exit(self, df):
        return df["close"] < ema(df["close"], self.params["period"])


class InsideBarBreakout(Strategy):
    type_name = "inside_bar"
    default_regimes = ("uptrend",)
    param_spec = {"exit_ma": (int, 5, 50)}
    description = "Nach einer Innenstab-Kerze schließt der Kurs über dem Hoch der Mutterkerze; Ausstieg unter der EMA."
    source = "Price-Action-Muster Inside Bar (u. a. Al Brooks)"

    def entry(self, df):
        h, l, c = df["high"], df["low"], df["close"]
        inside = (h.shift(1) < h.shift(2)) & (l.shift(1) > l.shift(2))
        return inside & (c > h.shift(2))

    def exit(self, df):
        return df["close"] < ema(df["close"], self.params["exit_ma"])


class SessionBreakout(Strategy):
    type_name = "session_breakout"
    default_regimes = ("uptrend", "downtrend", "sideways")
    param_spec = {"start_hour": (int, 0, 20), "range_hours": (int, 1, 8), "exit_hour": (int, 2, 23)}
    description = "Spanne der ersten Handelsstunden (UTC) – Kauf beim ersten Ausbruch darüber, Ausstieg zur Schlussstunde oder unter der Spanne (z. B. London-Breakout)."
    source = "Opening-Range-/London-Breakout (u. a. Toby Crabel, Day Trading with Short Term Price Patterns)"

    def _check(self):
        if self.params["start_hour"] + self.params["range_hours"] >= self.params["exit_hour"]:
            raise ValueError("session_breakout: start_hour + range_hours muss vor exit_hour liegen")

    def _signals(self, df):
        h, l, c = (df[k].to_numpy() for k in ("high", "low", "close"))
        hours = df.index.hour.to_numpy()
        days = (df.index.year * 10000 + df.index.month * 100 + df.index.day).to_numpy()
        s, e, x = self.params["start_hour"], self.params["start_hour"] + self.params["range_hours"], self.params["exit_hour"]
        entry = np.zeros(len(c), dtype=bool)
        exit_ = np.zeros(len(c), dtype=bool)
        day, rh, rl, done = None, -np.inf, np.inf, False
        for i in range(len(c)):
            if days[i] != day:
                day, rh, rl, done = days[i], -np.inf, np.inf, False
            hr = hours[i]
            if s <= hr < e:
                rh, rl = max(rh, h[i]), min(rl, l[i])
            elif e <= hr < x and not done and np.isfinite(rh) and c[i] > rh:
                entry[i], done = True, True
            exit_[i] = hr >= x or (np.isfinite(rl) and hr >= e and c[i] < rl)
        return entry, exit_

    def entry(self, df):
        return pd.Series(self._signals(df)[0], index=df.index)

    def exit(self, df):
        return pd.Series(self._signals(df)[1], index=df.index)


# =========================================================== Mean Reversion
class RSIReversion(Strategy):
    type_name = "rsi_reversion"
    default_regimes = ("sideways",)
    param_spec = {"period": (int, 5, 30), "oversold": (float, 10, 40), "exit_level": (float, 45, 80)}
    description = "Kauf bei überverkauftem RSI, Verkauf bei Erholung."
    source = "J. Welles Wilder, RSI (1978)"

    def entry(self, df):
        return rsi(df["close"], self.params["period"]) < self.params["oversold"]

    def exit(self, df):
        return rsi(df["close"], self.params["period"]) > self.params["exit_level"]


class ConnorsRSI2(Strategy):
    type_name = "connors_rsi2"
    default_regimes = ("uptrend", "sideways")
    param_spec = {"trend": (int, 50, 300), "rsi_period": (int, 2, 5), "oversold": (float, 2, 20), "exit_ma": (int, 3, 20)}
    description = "Kurs über dem langen SMA (Trendfilter) und sehr kurzer RSI stark überverkauft; Ausstieg über kurzem SMA."
    source = "Larry Connors & Cesar Alvarez, Short Term Trading Strategies That Work (2008)"

    def entry(self, df):
        c = df["close"]
        return (c > sma(c, self.params["trend"])) & (rsi(c, self.params["rsi_period"]) < self.params["oversold"])

    def exit(self, df):
        return df["close"] > sma(df["close"], self.params["exit_ma"])


class IBSReversion(Strategy):
    type_name = "ibs_reversion"
    default_regimes = ("uptrend", "sideways")
    param_spec = {"low": (float, 0.05, 0.4), "high": (float, 0.6, 0.95)}
    description = "Internal Bar Strength: Schluss nahe am Kerzentief -> Kauf; Schluss nahe am Hoch -> Verkauf."
    source = "IBS-Effekt (u. a. Pagonidis, 'The IBS Effect', NAAIM)"

    @staticmethod
    def _ibs(df):
        return (df["close"] - df["low"]) / (df["high"] - df["low"])

    def entry(self, df):
        return self._ibs(df) < self.params["low"]

    def exit(self, df):
        return self._ibs(df) > self.params["high"]


class BollingerReversion(Strategy):
    type_name = "bollinger_reversion"
    default_regimes = ("sideways",)
    param_spec = {"period": (int, 10, 50), "num_std": (float, 1.0, 3.5)}
    description = "Kauf unter dem unteren Bollinger-Band, Ausstieg an der Mittellinie."
    source = "John Bollinger, Bollinger on Bollinger Bands (2001)"

    def entry(self, df):
        lower, _, _ = bollinger(df["close"], self.params["period"], self.params["num_std"])
        return df["close"] < lower

    def exit(self, df):
        _, mid, _ = bollinger(df["close"], self.params["period"], self.params["num_std"])
        return df["close"] >= mid


class KeltnerReversion(Strategy):
    type_name = "keltner_reversion"
    default_regimes = ("sideways",)
    param_spec = {"period": (int, 10, 50), "mult": (float, 1.0, 4.0)}
    description = "Kauf unter dem unteren Keltner-Kanal (EMA - x * ATR), Ausstieg an der EMA."
    source = "Chester Keltner (1960) / Linda Raschke (ATR-Variante)"

    def entry(self, df):
        return df["close"] < ema(df["close"], self.params["period"]) - self.params["mult"] * atr(df, self.params["period"])

    def exit(self, df):
        return df["close"] > ema(df["close"], self.params["period"])


class ZScoreReversion(Strategy):
    type_name = "zscore_reversion"
    default_regimes = ("sideways",)
    param_spec = {"period": (int, 10, 100), "entry_z": (float, 1.0, 3.5), "exit_z": (float, -1.0, 1.0)}
    description = "Kurs liegt mehr als X Standardabweichungen unter dem Mittelwert; Ausstieg bei Rückkehr."
    source = "Statistische Mean Reversion (z. B. Chan, Algorithmic Trading, 2013)"

    def _z(self, df):
        c, n = df["close"], self.params["period"]
        return (c - sma(c, n)) / c.rolling(n).std(ddof=0)

    def entry(self, df):
        return self._z(df) < -self.params["entry_z"]

    def exit(self, df):
        return self._z(df) > self.params["exit_z"]


class WilliamsR(Strategy):
    type_name = "williams_r"
    default_regimes = ("sideways",)
    param_spec = {"period": (int, 5, 30), "oversold": (float, 70, 98), "exit_level": (float, 10, 60)}
    description = "Williams %R unter -oversold -> Kauf; über -exit_level -> Verkauf."
    source = "Larry Williams, Williams %R (1973)"

    def _wr(self, df):
        n = self.params["period"]
        hh, ll = df["high"].rolling(n).max(), df["low"].rolling(n).min()
        return -100 * (hh - df["close"]) / (hh - ll)

    def entry(self, df):
        return self._wr(df) < -self.params["oversold"]

    def exit(self, df):
        return self._wr(df) > -self.params["exit_level"]


class StochasticCross(Strategy):
    type_name = "stochastic"
    default_regimes = ("sideways",)
    param_spec = {"k": (int, 5, 30), "d": (int, 2, 10), "oversold": (float, 10, 35), "overbought": (float, 60, 90)}
    description = "%K kreuzt %D nach oben im überverkauften Bereich; Ausstieg im überkauften Bereich."
    source = "George Lane, Stochastik-Oszillator (1950er)"

    def _kd(self, df):
        n = self.params["k"]
        hh, ll = df["high"].rolling(n).max(), df["low"].rolling(n).min()
        k = 100 * (df["close"] - ll) / (hh - ll)
        return k, k.rolling(self.params["d"]).mean()

    def entry(self, df):
        k, d = self._kd(df)
        return _cross_up(k, d) & (k < self.params["oversold"])

    def exit(self, df):
        return self._kd(df)[0] > self.params["overbought"]


class CCIReversion(Strategy):
    type_name = "cci_reversion"
    default_regimes = ("sideways",)
    param_spec = {"period": (int, 10, 40), "level": (float, 80, 250), "exit_level": (float, -50, 100)}
    description = "Commodity Channel Index unter -level -> Kauf; über exit_level -> Verkauf."
    source = "Donald Lambert, CCI (1980)"

    def _cci(self, df):
        tp = (df["high"] + df["low"] + df["close"]) / 3
        n = self.params["period"]
        mad = tp.rolling(n).apply(lambda w: np.abs(w - w.mean()).mean(), raw=True)
        return (tp - sma(tp, n)) / (0.015 * mad)

    def entry(self, df):
        return self._cci(df) < -self.params["level"]

    def exit(self, df):
        return self._cci(df) > self.params["exit_level"]


class RangeSupport(Strategy):
    type_name = "range_support"
    default_regimes = ("sideways",)
    param_spec = {"lookback": (int, 20, 200), "zone": (float, 0.05, 0.5), "min_range_pct": (float, 0.2, 10.0),
                  "exit_frac": (float, 0.4, 1.0)}
    description = ("Range-Trading: Kauf, wenn der Kurs die Unterstützung (Tief der letzten N Kerzen) berührt und eine "
                   "bullische Kerze schließt; Ausstieg in der Nähe des Widerstands (Hoch der letzten N Kerzen).")
    source = "Unterstützungs-/Widerstandshandel, Range Trading (trading.de, Technische Analyse nach Murphy)"

    def _check(self):
        if self.params["exit_frac"] <= self.params["zone"]:
            raise ValueError("range_support: exit_frac muss größer als zone sein")

    def _levels(self, df):
        n = self.params["lookback"]
        sup = df["low"].rolling(n).min().shift(1)
        res = df["high"].rolling(n).max().shift(1)
        return sup, res - sup

    def entry(self, df):
        sup, width = self._levels(df)
        wide_enough = width / df["close"] * 100 >= self.params["min_range_pct"]
        touched = df["low"] <= sup + self.params["zone"] * width
        bullish = df["close"] > df["open"]
        return wide_enough & touched & bullish & (df["close"] >= sup)

    def exit(self, df):
        sup, width = self._levels(df)
        return df["close"] >= sup + self.params["exit_frac"] * width


class VWAPReversion(Strategy):
    type_name = "vwap_reversion"
    default_regimes = ("sideways",)
    param_spec = {"period": (int, 20, 200), "deviation": (float, 0.2, 5.0)}
    description = "Kurs liegt X % unter dem gleitenden VWAP -> Kauf; Ausstieg bei Rückkehr zum VWAP (braucht Volumen)."
    source = "VWAP-Reversion (institutionelle Ausführung, u. a. Berkowitz et al. 1988)"

    def _vwap(self, df):
        tp = (df["high"] + df["low"] + df["close"]) / 3
        n = self.params["period"]
        return (tp * df["volume"]).rolling(n).sum() / df["volume"].rolling(n).sum()

    def entry(self, df):
        return df["close"] < self._vwap(df) * (1 - self.params["deviation"] / 100)

    def exit(self, df):
        return df["close"] >= self._vwap(df)


class PullbackInTrend(Strategy):
    type_name = "trend_pullback"
    default_regimes = ("uptrend",)
    param_spec = {"trend": (int, 50, 300), "down_bars": (int, 2, 6), "exit_ma": (int, 3, 20)}
    description = "Im Aufwärtstrend (Kurs über langer EMA) nach N fallenden Schlusskursen kaufen; Ausstieg über kurzem SMA."
    source = "Buy-the-Dip im Trend (u. a. Connors, 'Multiple Days Down')"

    def entry(self, df):
        c = df["close"]
        downs = (c < c.shift(1)).astype(float).rolling(self.params["down_bars"]).sum()
        return (c > ema(c, self.params["trend"])) & (downs == self.params["down_bars"])

    def exit(self, df):
        return df["close"] > sma(df["close"], self.params["exit_ma"])


STRATEGY_TYPES: dict[str, type[Strategy]] = {
    cls.type_name: cls for cls in (
        MACrossover, TripleEMA, MACDCross, MACDZero, ADXTrend, Supertrend, ParabolicSAR, Ichimoku, HeikinAshi,
        ROCMomentum, Breakout, SqueezeBreakout, InsideBarBreakout, SessionBreakout, RSIReversion, ConnorsRSI2,
        IBSReversion, BollingerReversion, KeltnerReversion, ZScoreReversion, WilliamsR, StochasticCross,
        CCIReversion, RangeSupport, VWAPReversion, PullbackInTrend,
    )
}


def build_strategy(spec: dict[str, Any]) -> Strategy:
    """Erzeugt (und validiert) eine Strategie aus einer Spezifikation."""
    if not isinstance(spec, dict):
        raise ValueError("Strategie-Spezifikation muss ein Objekt sein")
    cls = STRATEGY_TYPES.get(spec.get("type", "")) if isinstance(spec.get("type"), str) else None
    if cls is None:
        raise ValueError(f"Unbekannter Strategietyp {spec.get('type')!r}; erlaubt: {sorted(STRATEGY_TYPES)}")
    params = spec.get("params")
    if not isinstance(params, dict):
        raise ValueError("'params' muss ein Objekt sein")
    return cls(regimes=spec.get("regimes"), **dict(params))


# Standard-Kandidaten: bekannte Parameter aus der Literatur; Mean-Reversion-Varianten teils mit nahem Ziel (rr),
# was die Trefferquote erhöht. Ob eine Variante etwas taugt, entscheidet ausschließlich der Backtest.
DEFAULT_SPECS: list[tuple[str, dict[str, Any]]] = [
    ("ma_crossover", {"fast": 9, "slow": 21}),
    ("ma_crossover", {"fast": 20, "slow": 50}),
    ("triple_ema", {"fast": 8, "mid": 21, "slow": 55}),
    ("macd_cross", {"fast": 12, "slow": 26, "signal": 9}),
    ("macd_zero", {"fast": 12, "slow": 26}),
    ("adx_di", {"period": 14, "threshold": 25}),
    ("supertrend", {"period": 10, "mult": 3.0}),
    ("parabolic_sar", {"step": 0.02, "max_af": 0.2}),
    ("ichimoku", {"tenkan": 9, "kijun": 26, "senkou_b": 52}),
    ("heikin_ashi", {"bars": 2}),
    ("roc_momentum", {"period": 12, "threshold": 1.0}),
    ("breakout", {"lookback": 20, "exit_lookback": 10}),
    ("breakout", {"lookback": 55, "exit_lookback": 20}),
    ("squeeze_breakout", {"period": 20, "bb_mult": 2.0, "kc_mult": 1.5}),
    ("inside_bar", {"exit_ma": 20}),
    ("session_breakout", {"start_hour": 7, "range_hours": 1, "exit_hour": 16}),
    ("rsi_reversion", {"period": 14, "oversold": 30, "exit_level": 55}),
    ("rsi_reversion", {"period": 7, "oversold": 20, "exit_level": 50}),
    ("connors_rsi2", {"trend": 200, "rsi_period": 2, "oversold": 10, "exit_ma": 5}),
    ("connors_rsi2", {"trend": 200, "rsi_period": 2, "oversold": 5, "exit_ma": 5, "stop_mult": 3.0, "rr": 1.0}),
    ("ibs_reversion", {"low": 0.2, "high": 0.8}),
    ("ibs_reversion", {"low": 0.1, "high": 0.7, "rr": 1.0}),
    ("bollinger_reversion", {"period": 20, "num_std": 2.0}),
    ("bollinger_reversion", {"period": 20, "num_std": 2.5, "stop_mult": 3.0, "rr": 1.0}),
    ("keltner_reversion", {"period": 20, "mult": 2.0}),
    ("zscore_reversion", {"period": 50, "entry_z": 2.0, "exit_z": 0.0}),
    ("zscore_reversion", {"period": 30, "entry_z": 2.5, "exit_z": -0.5, "rr": 1.0}),
    ("williams_r", {"period": 14, "oversold": 90, "exit_level": 30}),
    ("stochastic", {"k": 14, "d": 3, "oversold": 20, "overbought": 80}),
    ("cci_reversion", {"period": 20, "level": 150, "exit_level": 0}),
    ("range_support", {"lookback": 48, "zone": 0.25, "min_range_pct": 1.0, "exit_frac": 0.8}),
    ("vwap_reversion", {"period": 96, "deviation": 1.0}),
    ("trend_pullback", {"trend": 200, "down_bars": 3, "exit_ma": 5}),
    ("trend_pullback", {"trend": 100, "down_bars": 4, "exit_ma": 5, "rr": 1.0}),
]


def default_candidates() -> list[dict[str, Any]]:
    """Bekannte Standardstrategien mit festen Parametern (laufen ohne LLM)."""
    out = []
    for type_name, params in DEFAULT_SPECS:
        s = STRATEGY_TYPES[type_name](**params)
        spec = s.to_spec()
        spec["source"] = "builtin"
        spec["rationale"] = f"{s.description} Quelle: {s.source}"
        out.append(spec)
    return out


def describe_param_bounds() -> str:
    """Textliche Beschreibung der erlaubten Typen/Grenzen (für den LLM-Prompt)."""
    lines = []
    for name, cls in STRATEGY_TYPES.items():
        bounds = ", ".join(f"{k}: {t.__name__} in [{lo}, {hi}]" for k, (t, lo, hi) in cls.param_spec.items())
        lines.append(f'- "{name}": {cls.description} Parameter: {bounds}. Standard-Marktphasen: {list(cls.default_regimes)}')
    opt = ", ".join(f"{k}: {t.__name__} in [{lo}, {hi}]" for k, (t, lo, hi) in EXIT_SPEC.items())
    lines.append(f"Optional für jede Strategie: {opt} (stop_mult = Stop in ATR, rr = Ziel als Vielfaches des Risikos).")
    return "\n".join(lines)
