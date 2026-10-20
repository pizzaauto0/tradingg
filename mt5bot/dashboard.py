"""Oberfläche des MT5-Bots: liefert web/index.html und den Datenstand (mt5bot_snapshot.json) aus. Nur lesend – sie kann nicht handeln.

Am PC selbst (127.0.0.1) frei erreichbar. Mit lan=True zusätzlich vom Handy im gleichen WLAN (oder über ein privates VPN wie
Tailscale) – dann aber NUR mit dem geheimen Schlüssel im Link (?key=...). Der Schlüssel wird einmal zufällig erzeugt und in
mt5bot_dashboard_key.txt gespeichert; Datei löschen = neuer Schlüssel (alte Links funktionieren dann nicht mehr).
Einzeln starten: python -m mt5bot.dashboard
"""
from __future__ import annotations

import hmac
import ipaddress
import json
import os
import secrets
import socket
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import history, research, settings

WEB = Path(__file__).parent / "web" / "index.html"
KEY_FILE = "mt5bot_dashboard_key.txt"


def load_key(folder: Path) -> str:
    f = folder / KEY_FILE
    try:
        key = f.read_text(encoding="utf-8").strip()
        if len(key) >= 16:
            return key
    except OSError:
        pass
    key = secrets.token_urlsafe(18)
    f.write_text(key, encoding="utf-8")
    return key


def local_addresses() -> list[str]:
    """IP-Adressen dieses PCs im Heimnetz (und ggf. Tailscale 100.x). Es wird nichts gesendet."""
    found = []
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))  # UDP-"connect" verschickt kein Paket, liefert nur die Ausgangs-Adresse
            found.append(s.getsockname()[0])
    except OSError:
        pass
    try:
        found += socket.gethostbyname_ex(socket.gethostname())[2]
    except OSError:
        pass
    out = []
    for a in found:
        ip = ipaddress.ip_address(a)
        if (ip.is_private or ip in ipaddress.ip_network("100.64.0.0/10")) and not ip.is_loopback and a not in out:
            out.append(a)
    return out


COMMANDS = {"close", "closeall", "kill", "pause", "resume", "buy", "sell", "research", "research_cancel", "research_toggle", "save_settings", "reload", "telegram_start", "autostart"}
LOCAL_ONLY = {"research_toggle", "save_settings", "reload", "telegram_start", "autostart"}   # ändern Einstellungen/Strategien: nie vom Handy aus
ICON = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="36" fill="#0f172a"/>'
        '<path d="M28 134 L66 92 L96 114 L148 54" fill="none" stroke="#22c55e" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>'
        '<circle cx="148" cy="54" r="11" fill="#22c55e"/></svg>')


def make_handler(folder: Path, snapshot_file: str, key: str | None, phone_urls: list[str], ctl: dict | None = None):
    ctl = ctl or {}
    mode = ctl.get("mode", "off")  # "off" | "local" | "phone"
    csrf = secrets.token_urlsafe(24)
    class Handler(BaseHTTPRequestHandler):
        def _send(self, code: int, body: bytes, ctype: str) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")  # Schlüssel nicht an andere Seiten weitergeben
            self.end_headers()
            self.wfile.write(body)

        def _local(self) -> bool:
            return ipaddress.ip_address(self.client_address[0]).is_loopback

        def _control_allowed(self) -> bool:
            return bool(ctl.get("submit")) and (mode == "phone" or (mode == "local" and self._local()))

        def _safe_origin(self) -> bool:
            """Schutz vor fremden Webseiten (CSRF/DNS-Rebinding): Host muss einer unserer Adressen entsprechen, Origin (falls vorhanden) derselbe Host."""
            host = self.headers.get("Host", "")
            port = self.server.server_address[1]
            ok = {f"127.0.0.1:{port}", f"localhost:{port}"} | {f"{ip}:{port}" for ip in local_addresses()}
            origin = self.headers.get("Origin")
            return host in ok and (origin is None or origin == f"http://{host}")

        def _gate(self, url) -> bool:
            if self._local():
                return True
            given = parse_qs(url.query).get("key", [""])[0]
            if not key or not hmac.compare_digest(given, key):
                self._send(403, "Zugriff verweigert: Link mit gültigem Schlüssel nötig.".encode(), "text/plain; charset=utf-8")
                return False
            return True

        def do_GET(self):  # noqa: N802 (Name von http.server vorgegeben)
            url = urlparse(self.path)
            if not self._gate(url):
                return
            if url.path in ("/", "/index.html"):
                qs = "?key=" + parse_qs(url.query)["key"][0] if not self._local() and parse_qs(url.query).get("key") else ""
                page = (WEB.read_text(encoding="utf-8").replace("__CSRF__", csrf if self._control_allowed() else "").replace("__CONTROL__", "1" if self._control_allowed() else "0")
                        .replace("__QS__", qs.replace("&", "&amp;")).replace("__LOCAL__", "1" if self._local() else "0"))
                return self._send(200, page.encode("utf-8"), "text/html; charset=utf-8")
            if url.path == "/manifest.webmanifest":   # macht das Portal auf dem Handy zur „App“ (Zum Startbildschirm hinzufügen)
                qs = "?key=" + parse_qs(url.query)["key"][0] if parse_qs(url.query).get("key") else ""
                man = {"name": "MT5 Trading-Bot", "short_name": "MT5-Bot", "start_url": "/" + qs, "scope": "/", "display": "standalone",
                       "background_color": "#0f172a", "theme_color": "#0f172a", "icons": [{"src": "/icon.svg" + qs, "sizes": "any", "type": "image/svg+xml", "purpose": "any"}]}
                return self._send(200, json.dumps(man).encode(), "application/manifest+json")
            if url.path == "/icon.svg":
                return self._send(200, ICON.encode(), "image/svg+xml")
            if url.path == "/api/app":
                from . import autostart
                return self._send(200, json.dumps({"windows": os.name == "nt", "autostart": autostart.installed()}).encode(), "application/json")
            if url.path == "/api/settings":
                return self._send(200, json.dumps(settings.view(folder)).encode(), "application/json")
            if url.path == "/api/research":
                data = research.load(folder)
                state = ctl["research_state"]() if callable(ctl.get("research_state")) else {}
                state = {k: v for k, v in state.items() if k != "cancel"}
                return self._send(200, json.dumps({"data": data, "state": state}, default=str).encode(), "application/json")
            if url.path == "/api/telegram" and callable(ctl.get("tg_status")):
                return self._send(200, json.dumps(ctl["tg_status"]()).encode(), "application/json")
            if url.path == "/api/result":
                rid = parse_qs(url.query).get("id", [""])[0]
                res = (ctl.get("results") or {}).get(rid)
                return self._send(200 if res else 404, json.dumps(res or {"done": True, "text": "unbekannte Anfrage"}).encode(), "application/json")
            if url.path == "/api/snapshot":
                f = folder / snapshot_file
                if not f.exists():
                    return self._send(503, b'{"error": "Noch kein Datenstand - laeuft der Bot?"}', "application/json")
                return self._send(200, f.read_bytes(), "application/json")
            if url.path == "/api/history":
                try:
                    days = float(parse_qs(url.query).get("days", [""])[0] or 0) or None
                except ValueError:
                    days = None
                return self._send(200, json.dumps(history.summary(folder, days), default=str).replace("Infinity", "null").encode(), "application/json")
            if url.path == "/api/phone" and self._local():  # Handy-Link nur am PC selbst anzeigen
                return self._send(200, json.dumps({"urls": phone_urls}).encode(), "application/json")
            return self._send(404, b"nicht gefunden", "text/plain; charset=utf-8")

        def do_POST(self):  # noqa: N802
            url = urlparse(self.path)
            if not self._gate(url):
                return
            if url.path not in ("/api/command", "/api/telegram"):
                return self._send(404, b"nicht gefunden", "text/plain; charset=utf-8")
            if not self._control_allowed():
                return self._send(403, b'{"text": "Steuerung ist hier abgeschaltet (DASHBOARD_CONTROL)."}', "application/json")
            if not self._safe_origin() or not hmac.compare_digest(self.headers.get("X-CSRF", ""), csrf):
                return self._send(403, b'{"text": "Anfrage abgelehnt (Herkunft/Token)."}', "application/json")
            if url.path == "/api/telegram":   # Telegram einrichten: nur am PC selbst
                if not self._local() or ctl.get("tg_setup") is None:
                    return self._send(403, "{\"text\": \"Nur am PC selbst möglich.\"}".encode(), "application/json")
                try:
                    n = int(self.headers.get("Content-Length", "0"))
                    if not 0 < n <= 1024:
                        raise ValueError("Anfrage ungültig")
                    req = json.loads(self.rfile.read(n))
                    step, setup = req.get("step"), ctl["tg_setup"]
                    if step == "check":
                        out = setup.check(str(req.get("token", "")))
                    elif step == "find":
                        out = {"found": setup.find()}
                    elif step == "save":
                        setup.save(str(req.get("chat_id", "")))
                        out = {"id": ctl["submit"]({"type": "telegram_start"})}
                    else:
                        raise ValueError("Unbekannter Schritt")
                    return self._send(200, json.dumps(out).encode(), "application/json")
                except (ValueError, json.JSONDecodeError) as e:
                    return self._send(400, json.dumps({"text": str(e)}).encode(), "application/json")
            try:
                n = int(self.headers.get("Content-Length", "0"))
                if not 0 < n <= (16384 if self.headers.get("X-Big") else 2048):
                    raise ValueError
                cmd = json.loads(self.rfile.read(n))
                t = cmd.get("type")
                if t not in COMMANDS:
                    raise ValueError
                if t in LOCAL_ONLY and not self._local():
                    return self._send(403, "{\"text\": \"Einstellungen nur am PC selbst änderbar.\"}".encode(), "application/json")
                if t == "save_settings":
                    cmd = {"type": t, "overlay": settings.validate(cmd["overlay"])}   # schon hier prüfen: klare Fehlermeldung
                elif t == "research":
                    if cmd.get("mode") not in settings.MODES:
                        raise ValueError
                    cmd = {"type": t, "mode": cmd["mode"]}
                elif t == "autostart":
                    cmd = {"type": t, "on": bool(cmd.get("on"))}
                elif t == "research_toggle":
                    cmd = {"type": t, "market": str(cmd["market"])[:24], "tf": str(cmd["tf"]), "strategy": str(cmd["strategy"]), "params": dict(cmd["params"]),
                           "title": str(cmd.get("title", ""))[:80], "on": bool(cmd["on"])}
                elif t == "close":
                    cmd = {"type": t, "ticket": int(cmd["ticket"])}
                elif t in ("buy", "sell"):
                    risk = float(cmd.get("risk", 0.5))
                    sym = str(cmd.get("symbol", "")).upper()
                    if sym not in (ctl["symbols"]() if callable(ctl.get("symbols")) else []) or not 0 < risk <= 2:
                        raise ValueError
                    cmd = {"type": t, "symbol": sym, "risk": risk}
                else:
                    cmd = {"type": t}
            except (ValueError, KeyError, TypeError, json.JSONDecodeError) as e:
                msg = str(e) if isinstance(e, ValueError) and str(e) else "Ungueltiger Befehl."
                return self._send(400, json.dumps({"text": msg}).encode(), "application/json")
            return self._send(200, json.dumps({"id": ctl["submit"](cmd)}).encode(), "application/json")

        def log_message(self, *args):  # keine Zugriffszeilen im Bot-Log
            pass

    return Handler


def serve(folder, port: int, snapshot_file: str = "mt5bot_snapshot.json", open_browser: bool = True, lan: bool = False,
          control: str = "off", submit=None, results=None, symbols=None, research_state=None, tg_status=None, tg_setup=None) -> dict:
    folder = Path(folder)
    key = load_key(folder) if lan else None
    host = "0.0.0.0" if lan else "127.0.0.1"
    phone_urls: list[str] = []
    server = ThreadingHTTPServer((host, port), make_handler(folder, snapshot_file, key, phone_urls, {"mode": control, "submit": submit, "results": results, "symbols": symbols,
                                                                                                                            "research_state": research_state, "tg_status": tg_status, "tg_setup": tg_setup}))
    real_port = server.server_address[1]
    if lan:
        phone_urls += [f"http://{ip}:{real_port}/?key={key}" for ip in local_addresses()]
    threading.Thread(target=server.serve_forever, daemon=True, name="dashboard").start()
    local = f"http://127.0.0.1:{real_port}/"
    if open_browser:
        try:
            webbrowser.open(local)
        except Exception:
            pass
    return {"local": local, "phone": phone_urls, "server": server}


if __name__ == "__main__":
    import time

    from . import config

    info = serve(".", config.DASHBOARD_PORT or 8765, config.SNAPSHOT_FILE, lan=getattr(config, "DASHBOARD_PHONE", False))
    print("Oberfläche:", info["local"])
    for u in info["phone"]:
        print("Handy:", u)
    print("Beenden mit Strg+C")
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass
