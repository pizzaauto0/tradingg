"""Kleine Hilfsfunktionen."""
from __future__ import annotations

import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_TF = re.compile(r"^(\d+)([mhdw])$")
_UNITS = {"m": 60, "h": 3600, "d": 86400, "w": 604800}


def timeframe_seconds(timeframe: str) -> int:
    m = _TF.match(timeframe)
    if not m:
        raise ValueError(f"Ungültiger Zeitrahmen: {timeframe!r} (erwartet z. B. 15m, 1h, 1d)")
    return int(m.group(1)) * _UNITS[m.group(2)]


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def atomic_write_json(path: str | Path, obj: Any) -> None:
    """Schreibt JSON atomar, damit ein Absturz keine halbe Datei hinterlässt."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(obj, f, indent=2, default=str)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def read_json(path: str | Path, default: Any) -> Any:
    path = Path(path)
    if not path.exists():
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)
