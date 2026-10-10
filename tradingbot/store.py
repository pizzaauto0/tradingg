"""Ablage von Kandidaten, zugelassenen Strategien und Backtest-Berichten (JSON)."""
from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any

from .util import atomic_write_json, read_json, utcnow


class StrategyStore:
    def __init__(self, directory: str | Path):
        self.dir = Path(directory) / "strategies"
        self.candidates_path = self.dir / "candidates.json"
        self.approved_path = self.dir / "approved.json"
        self.report_path = self.dir / "backtest_report.json"

    def save_candidates(self, specs: list[dict[str, Any]]) -> None:
        atomic_write_json(self.candidates_path, {"generated_at": utcnow().isoformat(), "candidates": specs})

    def load_candidates(self) -> list[dict[str, Any]]:
        return read_json(self.candidates_path, {}).get("candidates", [])

    def save_approved(self, records: list[dict[str, Any]]) -> None:
        atomic_write_json(self.approved_path, {"generated_at": utcnow().isoformat(), "strategies": records})

    def load_approved(self) -> list[dict[str, Any]]:
        return read_json(self.approved_path, {}).get("strategies", [])

    def approved_age_hours(self) -> float | None:
        stamp = read_json(self.approved_path, {}).get("generated_at")
        if not stamp:
            return None
        return (utcnow() - datetime.fromisoformat(stamp)).total_seconds() / 3600

    def save_report(self, rows: list[dict[str, Any]]) -> None:
        atomic_write_json(self.report_path, {"generated_at": utcnow().isoformat(), "results": rows})
