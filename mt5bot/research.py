"""Strategie-Prüfung wie in der Erweiterung, aber auf den Kerzen aus MetaTrader 5.

Ablauf: Kandidaten (je nach Modus) × Märkte → Backtest mit Gebühren/Slippage und Out-of-Sample-Teil → Mindestwerte
(check_thresholds) → zugelassene Strategien werden je Markt nach Güte sortiert; die besten N handeln im Profil „auto“.
Reine pandas-Logik, ohne MT5-Zugriff (die Kerzen werden von außen übergeben) – deshalb ohne Terminal testbar.

Modi (wie in der Erweiterung): strict = strenge Schwellen, explore = lockere Schwellen, playbook/winrate/final = feste Strategielisten.
"""
from __future__ import annotations

import dataclasses
import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import pandas as pd

from tradingbot.backtest import WARMUP, Backtester, check_thresholds
from tradingbot.config import BacktestCfg, Config
from tradingbot.strategies import DEFAULT_SPECS, build_strategy

RESEARCH_FILE = "mt5bot_research.json"
BT_TF = {"M1": "1m", "M5": "5m", "M15": "15m", "M30": "30m", "H1": "1h", "H4": "4h", "D1": "1d", "W1": "1w"}
MIN_CANDLES = 400            # darunter ist die Prüfung nicht aussagekräftig
EXPLORE = dict(min_trades=8, min_return_pct=0.0, max_drawdown_pct=25.0, min_sharpe=0.0, min_win_rate_pct=35.0, min_profit_factor=1.0, min_oos_return_pct=-5.0)

# Feste Listen – 1:1 aus der Erweiterung (extension/lib/strategies.js)
PLAYBOOK = [
    ("Trendkanal-Ausbruch", "breakout", {"lookback": 55, "exit_lookback": 20}),
    ("Pullback im Trend (Swing)", "trend_pullback", {"trend": 100, "down_bars": 3, "exit_ma": 5}),
    ("Price Action: Inside Bar", "inside_bar", {"exit_ma": 20}),
    ("Range: Unterstützung kaufen", "range_support", {"lookback": 48, "zone": 0.25, "min_range_pct": 1.0, "exit_frac": 0.8}),
    ("Mean Reversion: Bollinger", "bollinger_reversion", {"period": 20, "num_std": 2.0}),
]
WINRATE5 = [
    ("Pullback im Trend (68 % Treffer)", "trend_pullback", {"trend": 100, "down_bars": 4, "exit_ma": 5, "rr": 1.0}),
    ("Stochastik (56 % Treffer)", "stochastic", {"k": 14, "d": 3, "oversold": 20, "overbought": 80}),
    ("Connors RSI(2) (62 % Treffer)", "connors_rsi2", {"trend": 200, "rsi_period": 2, "oversold": 10, "exit_ma": 5}),
    ("Z-Score-Rückkehr (58 % Treffer)", "zscore_reversion", {"period": 30, "entry_z": 2.5, "exit_z": -0.5, "rr": 1.0}),
    ("Bollinger-Rückkehr (58 % Treffer)", "bollinger_reversion", {"period": 20, "num_std": 2.5, "stop_mult": 3.0, "rr": 1.0}),
]
FINAL3 = [
    ("Trend + Rücksetzer (Connors RSI 2)", "connors_rsi2", {"trend": 200, "rsi_period": 2, "oversold": 10, "exit_ma": 5}),
    ("Video-Methode: Trend + Rücksetzer an der Linie", "ma_pullback", {"ma_period": 50, "slope_bars": 10, "touch_pct": 0.5, "exit_pct": 3.0}),
    ("IBS-Rücksetzer (Schlusskurs-Position)", "ibs_reversion", {"low": 0.2, "high": 0.8}),
]


def candidates(mode: str) -> list[tuple[str, str, dict]]:
    """[(Titel, Typ, Parameter)] für den Modus."""
    fixed = {"playbook": PLAYBOOK, "winrate": WINRATE5, "final": FINAL3}.get(mode)
    if fixed is not None:
        return list(fixed)
    out = []
    for type_name, params in DEFAULT_SPECS:
        out.append((build_strategy({"type": type_name, "params": params}).name, type_name, dict(params)))
    return out


def thresholds(mode: str) -> BacktestCfg:
    return dataclasses.replace(BacktestCfg(), **EXPLORE) if mode == "explore" else BacktestCfg()


def cost_for(market: str) -> tuple[float, float]:
    """(Gebühr %, Slippage %) je Marktart – dieselben Annahmen wie in survey/survey.py."""
    m = market.upper()
    if m.startswith(("XAU", "XAG", "XPT", "XPD", "XCU")):
        return 0.03, 0.03
    if m.startswith(("BTC", "ETH", "LTC", "XRP")):
        return 0.10, 0.05
    if m.startswith(("US", "DE", "JP", "UK", "FR", "EU", "HK", "AU")) and not re.fullmatch(r"[A-Z]{6}", m):
        return 0.02, 0.02
    if "OIL" in m or "GAS" in m:
        return 0.03, 0.05
    return 0.005, 0.01   # Forex


def _config(market: str, tf: str, mode: str, allow_short: bool) -> Config:
    cfg = Config(broker="ibkr")
    fee, slip = cost_for(market)
    return dataclasses.replace(
        cfg, market=dataclasses.replace(cfg.market, timeframe=BT_TF[tf], allow_short=allow_short),
        costs=dataclasses.replace(cfg.costs, fee_pct=fee, slippage_pct=slip), backtest=thresholds(mode))


def advice(failures: list[str], candles: int) -> str:
    """Die Verstöße in Klartext: was fehlt und was man tun kann („Warum (nicht)?“)."""
    if not failures:
        return "alle Mindestwerte erfüllt"
    tips = []
    for f in failures:
        if f.startswith("Trades"):
            tips.append("zu wenige Trades – kürzerer Zeitrahmen oder längere Historie liefert mehr")
        elif f.startswith("Rendite") or f.startswith("Out-of-Sample"):
            tips.append("Gewinn nach Kosten fehlt – Strategie passt zu diesem Markt/Zeitraum nicht")
        elif f.startswith("Max Drawdown"):
            tips.append("Verluststrecke zu tief")
        elif f.startswith("Trefferquote"):
            tips.append("zu wenig Gewinntrades für die Schwelle")
        elif f.startswith("Sharpe") or f.startswith("Profit"):
            tips.append("Gewinne zu unregelmäßig/zu klein gegenüber Verlusten")
    return "; ".join(dict.fromkeys(tips))


def score(m: dict) -> float:
    """Rangzahl der zugelassenen Strategien: Sharpe zählt am meisten, dann Out-of-Sample, Profitfaktor, Drawdown."""
    return m["sharpe"] * 10 + m["oos_return_pct"] * 0.5 + min(m["profit_factor"], 3.0) * 2 - m["max_drawdown_pct"] * 0.2


def run(frames: dict[tuple[str, str], pd.DataFrame], mode: str = "strict", allow_short: bool = False,
        progress: Callable[[int, int, str], None] | None = None, cancel: Callable[[], bool] | None = None) -> list[dict]:
    """frames: {(Markt, Zeitrahmen): Kerzen}. Gibt je Kandidat × Markt eine Zeile zurück."""
    cands = candidates(mode)
    total = len(cands) * len(frames)
    done = 0
    rows: list[dict] = []
    for (market, tf), df in frames.items():
        if df is None or len(df) < MIN_CANDLES or len(df) <= WARMUP + 2:
            rows.append({"market": market, "tf": tf, "title": "(Markt)", "type": "", "params": {}, "ok": False, "candles": 0 if df is None else len(df),
                         "failures": [f"zu wenige Kerzen ({0 if df is None else len(df)} < {MIN_CANDLES})"], "advice": "Historie im MetaTrader nachladen (Diagramm scrollen) oder Zeitrahmen ändern", "metrics": None})
            done += len(cands)
            continue
        cfg = _config(market, tf, mode, allow_short)
        bt = Backtester(cfg)
        for title, type_name, params in cands:
            if cancel and cancel():
                return rows
            done += 1
            if progress:
                progress(done, total, f"{market} {tf}: {title}")
            try:
                strat = build_strategy({"type": type_name, "params": params})
                res = bt.run(df, strat, symbol=market)
            except Exception as e:  # eine Strategie scheitert → die anderen laufen weiter
                rows.append({"market": market, "tf": tf, "title": title, "type": type_name, "params": params, "ok": False, "candles": len(df),
                             "failures": [f"Fehler: {type(e).__name__}: {e}"], "advice": "Strategie nicht berechenbar", "metrics": None})
                continue
            ok, failures = check_thresholds(res.metrics, cfg.backtest)
            rows.append({"market": market, "tf": tf, "title": title, "name": strat.name, "type": type_name, "params": params, "ok": bool(ok), "candles": len(df),
                         "years": round((df.index[-1] - df.index[0]).days / 365.25, 1), "metrics": {k: round(float(v), 3) for k, v in res.metrics.items()},
                         "failures": failures, "advice": advice(failures, len(df)), "score": round(score(res.metrics), 2)})
    return rows


def select_active(rows: list[dict], max_per_market: int = 2) -> list[dict]:
    """Je Markt die besten zugelassenen Strategien (höchstens eine je Typ), insgesamt höchstens 9 (Magic-Nummern 100301–100309)."""
    out, seen = [], {}
    for r in sorted((r for r in rows if r.get("ok")), key=lambda r: -r["score"]):
        used = seen.setdefault(r["market"], set())
        if len(used) >= max_per_market or r["type"] in used:
            continue
        used.add(r["type"])
        out.append({"market": r["market"], "tf": r["tf"], "type": r["type"], "params": r["params"], "title": r["title"], "score": r["score"], "source": "auto"})
        if len(out) >= 9:
            break
    return out


def path(folder) -> Path:
    return Path(folder) / RESEARCH_FILE


def load(folder) -> dict:
    try:
        d = json.loads(path(folder).read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def save(folder, data: dict) -> None:
    p = path(folder)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, p)


def finish(folder, rows: list[dict], mode: str, bars: int, max_per_market: int) -> dict:
    """Ergebnis speichern. Von Hand angehakte Strategien („manual“) bleiben aktiv, die automatische Auswahl wird neu bestimmt."""
    old = load(folder)
    manual = [a for a in old.get("active", []) if a.get("source") == "manual"]
    active = select_active(rows, max_per_market)
    data = {"time": datetime.now(timezone.utc).isoformat(), "mode": mode, "bars": bars, "results": rows,
            "active": (manual + active)[:9], "auto_active": active}
    save(folder, data)
    return data


def set_manual(folder, market: str, tf: str, type_name: str, params: dict, title: str, on: bool) -> dict:
    """Eine Strategie von Hand aktivieren/deaktivieren (auch wenn sie die Mindestwerte nicht erreicht hat – eigene Verantwortung)."""
    d = load(folder)
    if not d:
        raise ValueError("Noch keine Prüfung gelaufen.")
    act = [a for a in d.get("active", []) if not (a["market"] == market and a["type"] == type_name and a["params"] == params)]
    if on:
        if len(act) >= 9:
            raise ValueError("Höchstens 9 aktive Strategien.")
        act.append({"market": market, "tf": tf, "type": type_name, "params": params, "title": title, "score": None, "source": "manual"})
    d["active"] = act
    save(folder, d)
    return d


def due(folder, hours: float) -> bool:
    if hours <= 0:
        return False
    t = load(folder).get("time")
    if not t:
        return True
    return time.time() - datetime.fromisoformat(t).timestamp() >= hours * 3600


def summary_text(data: dict, limit: int = 8) -> str:
    if not data:
        return "Noch keine Strategie-Prüfung. Im Portal (Reiter Strategien) oder per /research starten."
    rows = [r for r in data.get("results", []) if r.get("metrics")]
    ok = [r for r in rows if r["ok"]]
    L = [f"Prüfung {data['time'][:16].replace('T', ' ')} UTC | Modus {data['mode']} | {len(rows)} Läufe, {len(ok)} zugelassen"]
    for a in data.get("active", [])[:limit]:
        L.append(f"  aktiv: {a['market']} {a['tf']} {a['title']}" + (" (von Hand)" if a.get("source") == "manual" else ""))
    if not data.get("active"):
        best = sorted(rows, key=lambda r: -r.get("score", -99))[:3]
        L.append("Keine Strategie zugelassen. Nächstbeste:")
        for r in best:
            L.append(f"  {r['market']} {r['tf']} {r['title']}: {r['advice']}")
    return "\n".join(L)
