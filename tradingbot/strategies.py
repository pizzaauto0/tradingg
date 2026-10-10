"""Strategie-Bausteine mit festen, validierten Parametern.

Strategien sind parametrisierte Klassen (Long-only, Spot). Auch LLM-Vorschläge
werden nur als Spezifikation {"type", "params", "regimes"} akzeptiert und gegen die
hier definierten Grenzen geprüft – es wird niemals generierter Code ausgeführt.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

import pandas as pd

from .analysis import REGIMES, bollinger, ema, rsi


class Strategy(ABC):
    type_name: str = ""
    default_regimes: tuple[str, ...] = ()
    # Parametername -> (Typ, Minimum, Maximum)
    param_spec: dict[str, tuple[type, float, float]] = {}
    description: str = ""

    def __init__(self, regimes: tuple[str, ...] | list[str] | None = None, **params: Any):
        unknown = set(params) - set(self.param_spec)
        missing = set(self.param_spec) - set(params)
        if unknown or missing:
            raise ValueError(f"{self.type_name}: unbekannte Parameter {sorted(unknown)}, fehlend {sorted(missing)}")
        clean: dict[str, Any] = {}
        for key, (typ, lo, hi) in self.param_spec.items():
            try:
                value = typ(params[key])
            except (TypeError, ValueError) as exc:
                raise ValueError(f"{self.type_name}.{key}: ungültiger Wert {params[key]!r}") from exc
            if not lo <= value <= hi:
                raise ValueError(f"{self.type_name}.{key}={value} außerhalb [{lo}, {hi}]")
            clean[key] = value
        self.params = clean
        self.regimes = tuple(regimes) if regimes else self.default_regimes
        bad = [r for r in self.regimes if r not in REGIMES]
        if bad or not self.regimes:
            raise ValueError(f"{self.type_name}: ungültige Marktphasen {bad or self.regimes}")
        self._check()

    def _check(self) -> None:
        """Zusätzliche Konsistenzprüfungen der Parameter."""

    @property
    def name(self) -> str:
        args = ",".join(f"{k}={v}" for k, v in self.params.items())
        return f"{self.type_name}({args})"

    def to_spec(self) -> dict[str, Any]:
        return {"type": self.type_name, "params": dict(self.params), "regimes": list(self.regimes)}

    @abstractmethod
    def entry(self, df: pd.DataFrame) -> pd.Series:
        """Bool-Serie: Einstiegssignal am Schluss der jeweiligen Kerze (nur Vergangenheit)."""

    @abstractmethod
    def exit(self, df: pd.DataFrame) -> pd.Series:
        """Bool-Serie: Ausstiegssignal am Schluss der jeweiligen Kerze."""

    @abstractmethod
    def explain(self, df: pd.DataFrame) -> str:
        """Begründung für das Signal der letzten Kerze (fürs Trade-Log)."""


class MACrossover(Strategy):
    type_name = "ma_crossover"
    default_regimes = ("uptrend",)
    param_spec = {"fast": (int, 3, 50), "slow": (int, 10, 200)}
    description = "Einstieg, wenn die schnelle EMA die langsame von unten kreuzt; Ausstieg bei Gegenkreuzung."

    def _check(self) -> None:
        if self.params["fast"] >= self.params["slow"]:
            raise ValueError("ma_crossover: fast muss kleiner als slow sein")

    def _emas(self, df):
        return ema(df["close"], self.params["fast"]), ema(df["close"], self.params["slow"])

    def entry(self, df):
        f, s = self._emas(df)
        return ((f > s) & (f.shift(1) <= s.shift(1))).fillna(False)

    def exit(self, df):
        f, s = self._emas(df)
        return (f < s).fillna(False)

    def explain(self, df):
        f, s = self._emas(df)
        return f"EMA{self.params['fast']} ({f.iloc[-1]:.2f}) kreuzt EMA{self.params['slow']} ({s.iloc[-1]:.2f}) nach oben"


class RSIReversion(Strategy):
    type_name = "rsi_reversion"
    default_regimes = ("sideways",)
    param_spec = {"period": (int, 5, 30), "oversold": (float, 10, 40), "exit_level": (float, 45, 80)}
    description = "Kauf bei überverkauftem RSI, Verkauf bei Erholung (Mean Reversion)."

    def entry(self, df):
        return (rsi(df["close"], self.params["period"]) < self.params["oversold"]).fillna(False)

    def exit(self, df):
        return (rsi(df["close"], self.params["period"]) > self.params["exit_level"]).fillna(False)

    def explain(self, df):
        r = rsi(df["close"], self.params["period"]).iloc[-1]
        return f"RSI({self.params['period']})={r:.1f} unter Schwelle {self.params['oversold']}"


class Breakout(Strategy):
    type_name = "breakout"
    default_regimes = ("uptrend",)
    param_spec = {"lookback": (int, 10, 200), "exit_lookback": (int, 5, 100)}
    description = "Einstieg bei Ausbruch über das Hoch der letzten N Kerzen; Ausstieg unter dem Tief der letzten M Kerzen."

    def _check(self) -> None:
        if self.params["exit_lookback"] > self.params["lookback"]:
            raise ValueError("breakout: exit_lookback darf lookback nicht überschreiten")

    def entry(self, df):
        level = df["high"].rolling(self.params["lookback"]).max().shift(1)
        return (df["close"] > level).fillna(False)

    def exit(self, df):
        level = df["low"].rolling(self.params["exit_lookback"]).min().shift(1)
        return (df["close"] < level).fillna(False)

    def explain(self, df):
        level = df["high"].rolling(self.params["lookback"]).max().shift(1).iloc[-1]
        return f"Schlusskurs {df['close'].iloc[-1]:.2f} über {self.params['lookback']}-Kerzen-Hoch {level:.2f}"


class BollingerReversion(Strategy):
    type_name = "bollinger_reversion"
    default_regimes = ("sideways",)
    param_spec = {"period": (int, 10, 50), "num_std": (float, 1.0, 3.5)}
    description = "Kauf unter dem unteren Bollinger-Band, Ausstieg an der Mittellinie."

    def entry(self, df):
        lower, _, _ = bollinger(df["close"], self.params["period"], self.params["num_std"])
        return (df["close"] < lower).fillna(False)

    def exit(self, df):
        _, mid, _ = bollinger(df["close"], self.params["period"], self.params["num_std"])
        return (df["close"] >= mid).fillna(False)

    def explain(self, df):
        lower, _, _ = bollinger(df["close"], self.params["period"], self.params["num_std"])
        return f"Schlusskurs {df['close'].iloc[-1]:.2f} unter unterem Band {lower.iloc[-1]:.2f}"


STRATEGY_TYPES: dict[str, type[Strategy]] = {
    cls.type_name: cls for cls in (MACrossover, RSIReversion, Breakout, BollingerReversion)
}


def build_strategy(spec: dict[str, Any]) -> Strategy:
    """Erzeugt (und validiert) eine Strategie aus einer Spezifikation."""
    if not isinstance(spec, dict):
        raise ValueError("Strategie-Spezifikation muss ein Objekt sein")
    cls = STRATEGY_TYPES.get(spec.get("type", ""))
    if cls is None:
        raise ValueError(f"Unbekannter Strategietyp {spec.get('type')!r}; erlaubt: {sorted(STRATEGY_TYPES)}")
    params = spec.get("params")
    if not isinstance(params, dict):
        raise ValueError("'params' muss ein Objekt sein")
    return cls(regimes=spec.get("regimes"), **params)


def default_candidates() -> list[dict[str, Any]]:
    """Bekannte Standardstrategien mit festen Parametern (laufen ohne LLM)."""
    specs = [
        MACrossover(fast=9, slow=21), MACrossover(fast=20, slow=50), MACrossover(fast=50, slow=200),
        RSIReversion(period=14, oversold=30, exit_level=55), RSIReversion(period=14, oversold=25, exit_level=50),
        RSIReversion(period=7, oversold=20, exit_level=50),
        Breakout(lookback=20, exit_lookback=10), Breakout(lookback=55, exit_lookback=20),
        BollingerReversion(period=20, num_std=2.0), BollingerReversion(period=20, num_std=2.5),
    ]
    out = []
    for s in specs:
        spec = s.to_spec()
        spec["source"] = "builtin"
        spec["rationale"] = s.description
        out.append(spec)
    return out


def describe_param_bounds() -> str:
    """Textliche Beschreibung der erlaubten Typen/Grenzen (für den LLM-Prompt)."""
    lines = []
    for name, cls in STRATEGY_TYPES.items():
        bounds = ", ".join(f"{k}: {t.__name__} in [{lo}, {hi}]" for k, (t, lo, hi) in cls.param_spec.items())
        lines.append(f'- "{name}": {cls.description} Parameter: {bounds}. Standard-Marktphasen: {list(cls.default_regimes)}')
    return "\n".join(lines)
