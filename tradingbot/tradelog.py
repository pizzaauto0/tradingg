"""Modul 8: Logging (Datei) und Trade-Protokoll mit Begründung (SQLite)."""
from __future__ import annotations

import logging
import logging.handlers
import sqlite3
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    mode TEXT NOT NULL,
    symbol TEXT NOT NULL,
    action TEXT NOT NULL,          -- ENTRY / EXIT
    price REAL NOT NULL,
    amount REAL NOT NULL,
    fee REAL NOT NULL,
    pnl REAL,                      -- nur bei EXIT (netto nach Gebühren)
    strategy TEXT,
    regime TEXT,
    reason TEXT NOT NULL,
    equity REAL
)
"""


def setup_logging(data_dir: Path, level: int = logging.INFO) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    root = logging.getLogger()
    if any(getattr(h, "_tradingbot", False) for h in root.handlers):
        return
    fmt = logging.Formatter("%(asctime)s %(levelname)-8s %(name)s: %(message)s")
    file_handler = logging.handlers.RotatingFileHandler(
        data_dir / "bot.log", maxBytes=5_000_000, backupCount=3, encoding="utf-8")
    console = logging.StreamHandler()
    for h in (file_handler, console):
        h.setFormatter(fmt)
        h._tradingbot = True  # type: ignore[attr-defined]
        root.addHandler(h)
    root.setLevel(level)


class TradeLog:
    def __init__(self, data_dir: Path):
        data_dir.mkdir(parents=True, exist_ok=True)
        self.path = data_dir / "trades.db"
        with self._conn() as c:
            c.execute(SCHEMA)

    def _conn(self) -> sqlite3.Connection:
        return sqlite3.connect(self.path)

    def record(self, *, ts: str, mode: str, symbol: str, action: str, price: float, amount: float,
               fee: float, reason: str, pnl: float | None = None, strategy: str = "",
               regime: str = "", equity: float | None = None) -> None:
        with self._conn() as c:
            c.execute(
                "INSERT INTO trades (ts, mode, symbol, action, price, amount, fee, pnl, strategy, regime, reason, equity) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (ts, mode, symbol, action, price, amount, fee, pnl, strategy, regime, reason, equity),
            )

    def recent(self, n: int = 10) -> list[dict[str, Any]]:
        with self._conn() as c:
            c.row_factory = sqlite3.Row
            rows = c.execute("SELECT * FROM trades ORDER BY id DESC LIMIT ?", (n,)).fetchall()
        return [dict(r) for r in rows]
