"""Optionale Telegram-Benachrichtigung (Fehler hier dürfen den Bot nie stoppen)."""
from __future__ import annotations

import logging
import os

import requests

from .config import Config

log = logging.getLogger(__name__)


class Notifier:
    def __init__(self, cfg: Config):
        self.mode = cfg.mode
        self.enabled = cfg.telegram.enabled
        self.token = os.environ.get(cfg.telegram.token_env, "")
        self.chat_id = os.environ.get(cfg.telegram.chat_id_env, "")
        if self.enabled and not (self.token and self.chat_id):
            log.warning("Telegram aktiviert, aber %s/%s fehlen – Benachrichtigungen aus.",
                        cfg.telegram.token_env, cfg.telegram.chat_id_env)
            self.enabled = False

    def send(self, text: str) -> None:
        log.info("NOTIFY: %s", text)
        if not self.enabled:
            return
        try:
            requests.post(
                f"https://api.telegram.org/bot{self.token}/sendMessage",
                json={"chat_id": self.chat_id, "text": f"[{self.mode.upper()}] {text}"[:4000]},
                timeout=10,
            ).raise_for_status()
        except Exception as exc:  # noqa: BLE001
            log.warning("Telegram-Versand fehlgeschlagen: %s", type(exc).__name__)
