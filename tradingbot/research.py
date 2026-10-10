"""Modul 3: Strategie-Recherche per LLM.

Das LLM schlägt bekannte Strategien als JSON-Spezifikation vor (Typ + feste Parameter).
Die Vorschläge werden gegen die erlaubten Typen/Grenzen validiert und landen nur als
*Kandidaten* in der Ablage. Zugelassen werden sie ausschließlich vom Backtester –
und es wird nie vom LLM erzeugter Code ausgeführt.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any

from .analysis import MarketState
from .config import Config
from .strategies import build_strategy, default_candidates, describe_param_bounds

log = logging.getLogger(__name__)

PROMPT = """Du bist ein quantitativer Analyst. Recherchiere aus deinem Wissen bekannte, \
robuste Handelsstrategien für Krypto-Spotmärkte (Long-only) auf {timeframe}-Kerzen und \
schlage bis zu {n} davon mit festen Parametern vor. Decke verschiedene Marktphasen ab \
(uptrend, downtrend, sideways).

Aktueller Marktzustand (Beispiel {symbol}): {state}

Du darfst AUSSCHLIESSLICH diese Strategietypen mit Parametern innerhalb der Grenzen verwenden:
{bounds}

Antworte NUR mit einem JSON-Array, ohne weiteren Text. Jedes Element:
{{"type": "<typ>", "params": {{...}}, "regimes": ["uptrend"|"downtrend"|"sideways", ...], \
"rationale": "<ein Satz, warum diese Strategie in diesen Marktphasen funktioniert>"}}
"""


def parse_proposals(text: str) -> list[dict[str, Any]]:
    """Extrahiert und validiert Vorschläge aus der LLM-Antwort; ungültige werden verworfen."""
    start, end = text.find("["), text.rfind("]")
    if start < 0 or end <= start:
        raise ValueError("Keine JSON-Liste in der LLM-Antwort gefunden")
    raw = json.loads(text[start:end + 1])
    if not isinstance(raw, list):
        raise ValueError("LLM-Antwort ist keine Liste")
    valid: list[dict[str, Any]] = []
    for item in raw:
        try:
            strategy = build_strategy(item)
        except ValueError as exc:
            log.warning("LLM-Vorschlag verworfen (%s): %s", exc, item)
            continue
        spec = strategy.to_spec()
        spec["source"] = "llm"
        spec["rationale"] = str(item.get("rationale", ""))[:500]
        valid.append(spec)
    return valid


def llm_candidates(cfg: Config, symbol: str, state: MarketState | None, n: int = 6) -> list[dict[str, Any]]:
    api_key = os.environ.get(cfg.llm.api_key_env, "")
    if not api_key:
        raise RuntimeError(f"Umgebungsvariable {cfg.llm.api_key_env} nicht gesetzt")
    import anthropic  # lazy: nur nötig, wenn das LLM-Modul aktiv ist

    prompt = PROMPT.format(
        timeframe=cfg.market.timeframe, n=n, symbol=symbol,
        state=state.summary() if state else "unbekannt", bounds=describe_param_bounds(),
    )
    client = anthropic.Anthropic(api_key=api_key)
    resp = client.messages.create(
        model=cfg.llm.model, max_tokens=cfg.llm.max_tokens,
        messages=[{"role": "user", "content": prompt}],
    )
    text = "".join(block.text for block in resp.content if getattr(block, "type", "") == "text")
    return parse_proposals(text)


def collect_candidates(cfg: Config, symbol: str, state: MarketState | None) -> list[dict[str, Any]]:
    """Standardstrategien + (falls aktiviert) LLM-Vorschläge, ohne Duplikate."""
    candidates = default_candidates()
    if cfg.llm.enabled:
        try:
            proposals = llm_candidates(cfg, symbol, state)
            log.info("LLM lieferte %d gültige Strategievorschläge", len(proposals))
            candidates += proposals
        except Exception as exc:  # noqa: BLE001 - Recherche ist optional, Bot läuft ohne weiter
            log.warning("LLM-Recherche fehlgeschlagen, nutze nur Standardstrategien: %s", exc)
    seen: set[str] = set()
    unique = []
    for spec in candidates:
        key = json.dumps([spec["type"], spec["params"], sorted(spec["regimes"])], sort_keys=True)
        if key not in seen:
            seen.add(key)
            unique.append(spec)
    return unique
