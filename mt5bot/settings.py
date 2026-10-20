"""Einstellungen, die man in der App ändern kann (statt config.py von Hand zu bearbeiten).

Gespeichert in mt5bot_settings.json (im Datenordner). Beim Start wird config.py (Standardwerte) mit dieser Datei überlagert.
SICHERHEIT: Diese Datei kann die harten Sperren NICHT ändern: ALLOW_REAL_ACCOUNT bleibt in config.py (Echtgeld-Konten brauchen eine
bewusste Änderung von Hand), das Risiko je Trade ist auf 2 % begrenzt, Tageslimit und Positionslimit haben feste Ober- und Untergrenzen.
"""
from __future__ import annotations

import copy
import json
import os
import types
from pathlib import Path

from . import config as base_config

SETTINGS_FILE = "mt5bot_settings.json"
TF_NAMES = ("M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1")
MODES = ("strict", "explore", "playbook", "winrate", "final")

# Allgemeine Einstellungen: Schlüssel -> (Konfig-Name, Typ, Minimum, Maximum, Beschriftung, Hinweis)
GENERAL = {
    "daily_loss_limit_pct": ("DAILY_LOSS_LIMIT_PCT", float, 0.5, 20.0, "Tagesverlust-Limit (%)", "Danach keine neuen Trades bis zum nächsten UTC-Tag."),
    "max_open_positions": ("MAX_OPEN_POSITIONS", int, 1, 20, "Max. offene Positionen (gesamt)", "Über alle Profile; korrelierte Märkte zählen einzeln."),
    "poll_seconds": ("POLL_SECONDS", int, 5, 600, "Prüf-Intervall (Sekunden)", "Neue Kerzen werden dabei erkannt; Entscheidung nur bei Kerzenschluss."),
    "report_minutes": ("REPORT_MINUTES", int, 10, 1440, "Bericht-Intervall (Minuten)", "Ausführlicher Bericht in logs/bericht_<Datum>.txt."),
    "telegram_report_hours": ("TELEGRAM_REPORT_HOURS", float, 0.0, 168.0, "Telegram-Kurzbericht (Stunden, 0 = aus)", ""),
    "research_bars": ("RESEARCH_BARS", int, 500, 50000, "Kerzen je Markt für die Strategie-Prüfung", "So viele Kerzen lädt die App von MetaTrader (mehr = längere Historie, falls der Broker sie liefert)."),
    "research_revalidate_hours": ("RESEARCH_REVALIDATE_HOURS", float, 0.0, 720.0, "Auto-Profil: Strategien neu prüfen alle … Stunden (0 = nur von Hand)", ""),
    "research_max_active": ("RESEARCH_MAX_ACTIVE", int, 1, 10, "Auto-Profil: aktive Strategien je Markt", "Nur die besten N zugelassenen Strategien handeln (höchstens eine je Typ)."),
}
CHOICES = {"dashboard_control": ("local", "phone", "off")}
STRINGS = {"terminal_path": ("MT5_TERMINAL_PATH", "Pfad zu terminal64.exe (leer = Terminal muss schon laufen)")}
BOOLS = {"dashboard_phone": ("DASHBOARD_PHONE", "Portal auch vom Handy erreichbar (mit geheimem Link)"),
         "telegram_enabled": ("TELEGRAM_ENABLED", "Telegram verwenden"),
         "manual_enabled": (None, "Manuell kaufen/verkaufen (Telegram/Portal) erlauben")}


def path(folder) -> Path:
    return Path(folder) / SETTINGS_FILE


def read(folder) -> dict:
    try:
        d = json.loads(path(folder).read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def write(folder, overlay: dict) -> None:
    p = path(folder)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(overlay, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, p)


def base_namespace() -> types.SimpleNamespace:
    """Kopie der Werte aus config.py (Großbuchstaben) – die Standardwerte."""
    ns = types.SimpleNamespace(**{k: copy.deepcopy(getattr(base_config, k)) for k in dir(base_config) if k.isupper()})
    return ns


def validate(overlay: dict) -> dict:
    """Prüft und bereinigt eine Überlagerung; wirft ValueError mit lesbarer Meldung. Unbekannte Schlüssel werden verworfen."""
    out: dict = {}
    g = overlay.get("general", {}) or {}
    clean: dict = {}
    for key, (_, typ, lo, hi, label, _h) in GENERAL.items():
        if key in g:
            try:
                v = typ(g[key])
            except (TypeError, ValueError):
                raise ValueError(f"{label}: ungültige Zahl") from None
            if not lo <= v <= hi:
                raise ValueError(f"{label}: erlaubt sind {lo:g} bis {hi:g}")
            clean[key] = v
    for key, allowed in CHOICES.items():
        if key in g:
            if g[key] not in allowed:
                raise ValueError(f"{key}: erlaubt sind {', '.join(allowed)}")
            clean[key] = g[key]
    for key in STRINGS:
        if key in g:
            s = str(g[key]).strip()
            if len(s) > 400 or "\n" in s:
                raise ValueError("Pfad ungültig")
            clean[key] = s
    for key in BOOLS:
        if key in g:
            clean[key] = bool(g[key])
    if "manual_risk_percent" in g:
        try:
            r = float(g["manual_risk_percent"])
        except (TypeError, ValueError):
            raise ValueError("Manuelles Risiko: ungültige Zahl") from None
        if not 0.05 <= r <= 2.0:
            raise ValueError("Manuelles Risiko: erlaubt sind 0,05 bis 2 %")
        clean["manual_risk_percent"] = r
    out["general"] = clean

    known = {p["name"] for p in base_config.PROFILES}
    profs: dict = {}
    for name, p in (overlay.get("profiles", {}) or {}).items():
        if name not in known:
            raise ValueError(f"Unbekanntes Profil: {name}")
        c: dict = {}
        if "enabled" in p:
            c["enabled"] = bool(p["enabled"])
        if "risk_percent" in p:
            try:
                r = float(p["risk_percent"])
            except (TypeError, ValueError):
                raise ValueError(f"{name}: Risiko ungültig") from None
            if not 0.05 <= r <= 2.0:
                raise ValueError(f"{name}: Risiko muss zwischen 0,05 und 2 % liegen")
            c["risk_percent"] = r
        if "markets" in p:
            m = p["markets"]
            if not isinstance(m, dict) or len(m) > 40:
                raise ValueError(f"{name}: Märkte ungültig")
            mk = {}
            for sym, tf in m.items():
                sym = str(sym).strip()
                if not sym or len(sym) > 24 or not all(ch.isalnum() or ch in "._-+#" for ch in sym):
                    raise ValueError(f"{name}: Symbol '{sym}' ungültig")
                if tf not in TF_NAMES:
                    raise ValueError(f"{name}: Zeitrahmen '{tf}' ungültig (erlaubt: {', '.join(TF_NAMES)})")
                mk[sym] = tf
            c["markets"] = mk
        if "mode" in p:
            if p["mode"] not in MODES:
                raise ValueError(f"{name}: Modus muss einer von {', '.join(MODES)} sein")
            c["mode"] = p["mode"]
        profs[name] = c
    out["profiles"] = profs
    return out


def effective(folder) -> types.SimpleNamespace:
    """Standardwerte aus config.py, überlagert mit mt5bot_settings.json."""
    cfg = base_namespace()
    ov = validate(read(folder)) if read(folder) else {"general": {}, "profiles": {}}
    g = ov["general"]
    for key, (attr, *_rest) in GENERAL.items():
        if key in g:
            setattr(cfg, attr, g[key])
    for key, (attr, _) in STRINGS.items():
        if key in g:
            setattr(cfg, attr, g[key] or None)
    for key, (attr, _) in BOOLS.items():
        if key in g and attr:
            setattr(cfg, attr, g[key])
    if "dashboard_control" in g:
        cfg.DASHBOARD_CONTROL = g["dashboard_control"]
    manual = dict(cfg.MANUAL)
    if "manual_enabled" in g:
        manual["enabled"] = g["manual_enabled"]
    if "manual_risk_percent" in g:
        manual["risk_percent"] = g["manual_risk_percent"]
    cfg.MANUAL = manual
    profiles = []
    for p in cfg.PROFILES:
        p = copy.deepcopy(p)
        o = ov["profiles"].get(p["name"], {})
        for k in ("enabled", "risk_percent", "markets"):
            if k in o:
                p[k] = o[k]
        if "mode" in o and isinstance(p.get("strategy"), dict) and p["strategy"].get("type") == "auto":
            p["strategy"]["mode"] = o["mode"]
        profiles.append(p)
    cfg.PROFILES = profiles
    return cfg


def view(folder) -> dict:
    """Alles, was die Einstellungsseite zum Anzeigen braucht: aktuelle Werte, Grenzen, Profile."""
    cfg = effective(folder)
    general = {}
    for key, (attr, typ, lo, hi, label, hint) in GENERAL.items():
        general[key] = {"value": getattr(cfg, attr), "type": typ.__name__, "min": lo, "max": hi, "label": label, "hint": hint}
    general["dashboard_control"] = {"value": cfg.DASHBOARD_CONTROL, "type": "choice", "choices": list(CHOICES["dashboard_control"]),
                                    "label": "Klick-Steuerung im Portal", "hint": "local = nur am PC selbst; phone = auch vom Handy (jeder mit dem Link kann handeln!); off = nur Ansehen."}
    for key, (attr, label) in STRINGS.items():
        general[key] = {"value": getattr(cfg, attr) or "", "type": "string", "label": label, "hint": ""}
    for key, (attr, label) in BOOLS.items():
        value = cfg.MANUAL.get("enabled", True) if key == "manual_enabled" else getattr(cfg, attr)
        general[key] = {"value": bool(value), "type": "bool", "label": label, "hint": ""}
    general["manual_risk_percent"] = {"value": cfg.MANUAL.get("risk_percent", 0.5), "type": "float", "min": 0.05, "max": 2.0, "label": "Risiko bei manuellen Trades (%)", "hint": ""}
    profiles = []
    for p in cfg.PROFILES:
        s = p["strategy"]
        profiles.append({"name": p["name"], "enabled": p.get("enabled", True), "risk_percent": p.get("risk_percent", 1.0), "markets": p["markets"],
                         "strategy": ("Auto: " + s.get("mode", "strict")) if s.get("type") == "auto" else f"{s['type']} {json.dumps(s.get('params', {}), ensure_ascii=False)}",
                         "auto": s.get("type") == "auto", "mode": s.get("mode"), "magic": p["magic"]})
    return {"general": general, "profiles": profiles, "modes": list(MODES), "timeframes": list(TF_NAMES), "real_account_allowed": bool(cfg.ALLOW_REAL_ACCOUNT)}
