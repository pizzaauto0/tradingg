"""Recherche -> Backtest -> Zulassung. Nur hier entstehen zugelassene Strategien."""
from __future__ import annotations

import logging
from typing import Any

from .analysis import MarketState, classify_market
from .backtest import Backtester, check_thresholds
from .config import Config
from .data import MarketData
from .research import collect_candidates
from .store import StrategyStore
from .strategies import build_strategy

log = logging.getLogger(__name__)


def research_and_backtest(cfg: Config, data: MarketData, store: StrategyStore) -> list[dict[str, Any]]:
    """Lädt Historie, holt Kandidaten (Standard + LLM), testet jede Strategie je Symbol
    und speichert die zugelassenen. Gibt die Liste der zugelassenen Strategien zurück."""
    histories = {}
    for symbol in cfg.market.symbols:
        try:
            df = data.fetch_history(symbol, cfg.market.history_candles)
        except Exception as exc:  # noqa: BLE001
            log.error("Historie für %s nicht ladbar: %s", symbol, exc)
            continue
        if len(df) < cfg.backtest.min_candles:
            log.warning("%s: nur %d Kerzen (min. %d) – keine Zulassung möglich", symbol, len(df),
                        cfg.backtest.min_candles)
            continue
        histories[symbol] = df
    if not histories:
        raise RuntimeError("Keine ausreichende Historie für Backtests verfügbar.")

    first_symbol = next(iter(histories))
    state: MarketState | None = None
    try:
        state = classify_market(histories[first_symbol])
    except ValueError:
        pass
    candidates = collect_candidates(cfg, first_symbol, state)
    store.save_candidates(candidates)
    log.info("%d Kandidaten, Backtest auf %d Symbol(en)", len(candidates), len(histories))

    backtester = Backtester(cfg)
    approved: list[dict[str, Any]] = []
    report: list[dict[str, Any]] = []
    for spec in candidates:
        try:
            strategy = build_strategy(spec)
        except ValueError as exc:
            log.warning("Kandidat übersprungen: %s", exc)
            continue
        for symbol, df in histories.items():
            result = backtester.run(df, strategy, symbol)
            ok, failures = check_thresholds(result.metrics, cfg.backtest)
            row = {"symbol": symbol, "timeframe": cfg.market.timeframe, "strategy": strategy.name,
                   "source": spec.get("source", ""), "approved": ok, "failures": failures,
                   "metrics": result.metrics}
            report.append(row)
            if ok:
                approved.append({"symbol": symbol, "timeframe": cfg.market.timeframe, "spec": strategy.to_spec(),
                                 "name": strategy.name, "source": spec.get("source", ""),
                                 "rationale": spec.get("rationale", ""), "metrics": result.metrics})
    store.save_approved(approved)
    store.save_report(report)
    print_report(report)
    log.info("%d von %d Tests bestanden", len(approved), len(report))
    return approved


def print_report(report: list[dict[str, Any]]) -> None:
    header = f"{'Symbol':<10} {'Strategie':<48} {'Rendite%':>9} {'MaxDD%':>7} {'Sharpe':>7} {'Treffer%':>9} {'Trades':>7}  Ergebnis"
    print("\n" + header + "\n" + "-" * len(header))
    for r in sorted(report, key=lambda x: (not x["approved"], -x["metrics"]["sharpe"])):
        m = r["metrics"]
        verdict = "ZUGELASSEN" if r["approved"] else "abgelehnt: " + "; ".join(r["failures"][:2])
        print(f"{r['symbol']:<10} {r['strategy']:<48} {m['return_pct']:>9.2f} {m['max_drawdown_pct']:>7.2f} "
              f"{m['sharpe']:>7.2f} {m['win_rate_pct']:>9.1f} {m['trades']:>7.0f}  {verdict}")
    print()
