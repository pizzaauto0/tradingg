#!/usr/bin/env python3
"""Trading-Bot – Kommandozeile.

  python main.py research    Strategien recherchieren + backtesten, zugelassene speichern
  python main.py run         Bot starten (Paper-Modus, solange live_trading: false)
  python main.py run --once  nur einen Durchlauf
  python main.py status      Positionen, Tageslimit und letzte Trades anzeigen
  python main.py kill        Kill Switch auslösen (alle Positionen werden geschlossen)
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
from datetime import timedelta
from pathlib import Path

from tradingbot.config import ConfigError, load_config
from tradingbot.data import MarketData
from tradingbot.engine import TradingEngine, load_state
from tradingbot.execution import LiveBroker, PaperBroker
from tradingbot.notify import Notifier
from tradingbot.pipeline import research_and_backtest
from tradingbot.store import StrategyStore
from tradingbot.tradelog import TradeLog, setup_logging
from tradingbot.util import utcnow

log = logging.getLogger("main")


def load_env_file(path: str = ".env") -> None:
    """Lädt KEY=VALUE-Zeilen aus .env in die Umgebung (bereits gesetzte Variablen haben Vorrang)."""
    p = Path(path)
    if not p.exists():
        return
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def cmd_research(cfg) -> int:
    store = StrategyStore(cfg.data_dir)
    approved = research_and_backtest(cfg, MarketData(cfg), store)
    print(f"{len(approved)} zugelassene Strategie(n) gespeichert in {store.approved_path}")
    return 0 if approved else 1


def cmd_run(cfg, once: bool) -> int:
    if cfg.live_trading:
        cfg.live_credentials()  # bricht mit klarer Meldung ab, falls Keys fehlen
        print("=" * 70)
        print(" LIVE-MODUS: Es werden ECHTE Orders mit echtem Geld platziert!")
        print(f" Maximal eingesetztes Kapital: {cfg.capital.start} {cfg.quote}")
        print("=" * 70)
    else:
        print("PAPER-MODUS: simulierter Handel, es werden keine echten Orders gesendet.")

    data = MarketData(cfg)
    store = StrategyStore(cfg.data_dir)
    state_path = cfg.data_dir / "state_live.json" if cfg.live_trading else cfg.data_dir / "state_paper.json"
    state = load_state(state_path)
    broker = LiveBroker(cfg) if cfg.live_trading else PaperBroker(cfg, state)
    notifier = Notifier(cfg)

    def refresh():
        return research_and_backtest(cfg, data, store)

    age = store.approved_age_hours()
    if Path(cfg.risk.kill_switch_file).exists():
        approved = store.load_approved()  # Kill Switch hat Vorrang: nichts nachladen, nur schließen
    elif age is None or age >= cfg.pipeline.revalidate_hours:
        log.info("Keine aktuellen Zulassungen – starte Recherche und Backtest")
        approved = refresh()
        state["last_refresh"] = utcnow().isoformat()
    else:
        approved = store.load_approved()
        state["last_refresh"] = (utcnow() - timedelta(hours=age)).isoformat()
    if not approved:
        log.warning("Keine Strategie hat den Backtest bestanden – der Bot handelt nicht, "
                    "prüft aber weiter regelmäßig neu.")

    engine = TradingEngine(cfg, data, broker, TradeLog(cfg.data_dir), notifier, state, state_path,
                           approved, refresher=refresh)
    if cfg.live_trading:
        engine.reconcile()
    if once:
        engine.tick()
        return 0
    engine.run_forever()
    return 0


def cmd_status(cfg) -> int:
    state_path = cfg.data_dir / ("state_live.json" if cfg.live_trading else "state_paper.json")
    state = load_state(state_path)
    print(f"Modus: {cfg.mode.upper()}")
    paper = state.get("paper")
    if paper:
        print(f"Paper-Guthaben (Bargeld): {paper['cash']:.2f} {cfg.quote}")
    print(f"Tageslimit-Status: {state.get('risk', {})}")
    positions = state.get("positions", {})
    print(f"Offene Positionen: {len(positions)}")
    for sym, p in positions.items():
        print(f"  {sym}: {p['amount']:.6f} @ {p['entry_price']:.2f} | Stop {p['stop']:.2f} | "
              f"Ziel {p['take_profit']:.2f} | {p['strategy_name']}")
    print("Letzte Trades:")
    for t in TradeLog(cfg.data_dir).recent(10):
        pnl = f" PnL {t['pnl']:+.2f}" if t["pnl"] is not None else ""
        print(f"  {t['ts'][:19]} {t['action']:<5} {t['symbol']} @ {t['price']:.2f}{pnl} | {t['reason'][:90]}")
    return 0


def cmd_kill(cfg) -> int:
    path = Path(cfg.risk.kill_switch_file)
    path.write_text(f"Kill Switch ausgelöst {utcnow().isoformat()}\n")
    print(f"Kill Switch gesetzt ({path}). Der laufende Bot schließt alle Positionen und beendet sich.")
    print("Läuft kein Bot, schließt der nächste Start (python main.py run) zuerst alle Positionen.")
    print(f"Zum Zurücksetzen die Datei {path} löschen.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Modularer Trading-Bot")
    parser.add_argument("--config", default="config.yaml")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("research")
    run = sub.add_parser("run")
    run.add_argument("--once", action="store_true", help="nur einen Durchlauf ausführen")
    sub.add_parser("status")
    sub.add_parser("kill")
    args = parser.parse_args(argv)

    load_env_file()
    try:
        cfg = load_config(args.config)
    except ConfigError as exc:
        print(f"Konfigurationsfehler: {exc}", file=sys.stderr)
        return 2
    setup_logging(cfg.data_dir)

    try:
        if args.cmd == "research":
            return cmd_research(cfg)
        if args.cmd == "run":
            return cmd_run(cfg, args.once)
        if args.cmd == "status":
            return cmd_status(cfg)
        return cmd_kill(cfg)
    except ConfigError as exc:
        print(f"Konfigurationsfehler: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
