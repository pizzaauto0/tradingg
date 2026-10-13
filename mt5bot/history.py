"""Auswertungen aus abgeschlossenen Trades (mt5bot_trades.csv) und Kapitalverlauf (mt5bot_equity.csv).

Reine Dateifunktionen ohne MetaTrader – für das Portal, Telegram und die Berichte.
"""
from __future__ import annotations

import csv
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

TRADES_FILE = "mt5bot_trades.csv"
EQUITY_FILE = "mt5bot_equity.csv"
TRADE_COLS = ["opened", "closed", "profile", "symbol", "direction", "lots", "entry", "exit", "sl0", "pnl", "r", "days", "close_reason", "open_reason"]


def append_trade(folder: Path, row: dict) -> None:
    f = Path(folder) / TRADES_FILE
    new = not f.exists()
    with open(f, "a", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=TRADE_COLS)
        if new:
            w.writeheader()
        w.writerow({c: row.get(c, "") for c in TRADE_COLS})


def _num(x):
    try:
        v = float(x)
        return v if v == v else None
    except (TypeError, ValueError):
        return None


def read_trades(folder: Path) -> list[dict]:
    f = Path(folder) / TRADES_FILE
    if not f.exists():
        return []
    with open(f, newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    for r in rows:
        for k in ("lots", "entry", "exit", "sl0", "pnl", "r", "days"):
            r[k] = _num(r.get(k))
    return rows


def append_equity(folder: Path, ts: datetime, equity: float) -> None:
    f = Path(folder) / EQUITY_FILE
    new = not f.exists()
    with open(f, "a", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        if new:
            w.writerow(["time", "equity"])
        w.writerow([ts.astimezone(timezone.utc).isoformat(timespec="seconds"), f"{equity:.2f}"])


def read_equity(folder: Path, days: float | None = None, max_points: int = 600) -> list[list]:
    f = Path(folder) / EQUITY_FILE
    if not f.exists():
        return []
    with open(f, newline="", encoding="utf-8") as fh:
        rows = [(r["time"], _num(r["equity"])) for r in csv.DictReader(fh)]
    rows = [(t, v) for t, v in rows if v is not None]
    if days:
        cut = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        rows = [x for x in rows if x[0] >= cut]
    if len(rows) > max_points:  # gleichmäßig ausdünnen, erste und letzte Zeile bleiben
        step = len(rows) / max_points
        rows = [rows[int(i * step)] for i in range(max_points)] + [rows[-1]]
    return [[t, v] for t, v in rows]


def stats(trades: list[dict]) -> dict:
    """Kennzahlen insgesamt und je Profil: Trades, Trefferquote, Profitfaktor, Erwartungswert in R, Summe."""
    def one(ts):
        pnl = [t["pnl"] for t in ts if t["pnl"] is not None]
        rs = [t["r"] for t in ts if t["r"] is not None]
        wins, losses = [x for x in pnl if x > 0], [-x for x in pnl if x <= 0]
        return {"trades": len(ts), "wins": len(wins), "win_rate": (len(wins) / len(pnl) * 100) if pnl else None,
                "profit_factor": (sum(wins) / sum(losses)) if losses and sum(losses) > 0 else (None if not wins else float("inf")),
                "pnl": sum(pnl), "avg_r": (sum(rs) / len(rs)) if rs else None, "best": max(pnl) if pnl else None, "worst": min(pnl) if pnl else None}
    by = defaultdict(list)
    for t in trades:
        by[t["profile"]].append(t)
    return {"all": one(trades), "profiles": {k: one(v) for k, v in sorted(by.items())}}


def periods(trades: list[dict], now: datetime | None = None) -> dict:
    """P&L heute / diese Woche / dieser Monat (Ortszeit) und je Kalendermonat."""
    now = (now or datetime.now()).astimezone()
    today, week0, month0 = now.date(), (now - timedelta(days=now.weekday())).date(), now.replace(day=1).date()
    out = {"today": 0.0, "week": 0.0, "month": 0.0, "n_today": 0, "n_week": 0, "n_month": 0}
    months = defaultdict(lambda: [0.0, 0])
    for t in trades:
        if t["pnl"] is None or not t["closed"]:
            continue
        d = datetime.fromisoformat(t["closed"]).astimezone().date()
        months[d.strftime("%Y-%m")][0] += t["pnl"]
        months[d.strftime("%Y-%m")][1] += 1
        if d == today:
            out["today"] += t["pnl"]; out["n_today"] += 1
        if d >= week0:
            out["week"] += t["pnl"]; out["n_week"] += 1
        if d >= month0:
            out["month"] += t["pnl"]; out["n_month"] += 1
    out["months"] = [{"month": m, "pnl": v[0], "n": v[1]} for m, v in sorted(months.items(), reverse=True)[:12]]
    return out


def summary(folder: Path, days: float | None = None) -> dict:
    trades = read_trades(folder)
    return {"stats": stats(trades), "periods": periods(trades), "trades": trades[-30:][::-1], "equity": read_equity(folder, days)}
