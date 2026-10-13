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
import secrets
import socket
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import history

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


COMMANDS = {"close", "closeall", "kill", "pause", "resume", "buy", "sell"}


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
                page = WEB.read_text(encoding="utf-8").replace("__CSRF__", csrf if self._control_allowed() else "").replace("__CONTROL__", "1" if self._control_allowed() else "0")
                return self._send(200, page.encode("utf-8"), "text/html; charset=utf-8")
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
            if url.path != "/api/command":
                return self._send(404, b"nicht gefunden", "text/plain; charset=utf-8")
            if not self._control_allowed():
                return self._send(403, b'{"text": "Steuerung ist hier abgeschaltet (DASHBOARD_CONTROL)."}', "application/json")
            if not self._safe_origin() or not hmac.compare_digest(self.headers.get("X-CSRF", ""), csrf):
                return self._send(403, b'{"text": "Anfrage abgelehnt (Herkunft/Token)."}', "application/json")
            try:
                n = int(self.headers.get("Content-Length", "0"))
                if not 0 < n <= 2048:
                    raise ValueError
                cmd = json.loads(self.rfile.read(n))
                t = cmd.get("type")
                if t not in COMMANDS:
                    raise ValueError
                if t == "close":
                    cmd = {"type": t, "ticket": int(cmd["ticket"])}
                elif t in ("buy", "sell"):
                    risk = float(cmd.get("risk", 0.5))
                    sym = str(cmd.get("symbol", "")).upper()
                    if sym not in (ctl["symbols"]() if callable(ctl.get("symbols")) else []) or not 0 < risk <= 2:
                        raise ValueError
                    cmd = {"type": t, "symbol": sym, "risk": risk}
                else:
                    cmd = {"type": t}
            except (ValueError, KeyError, TypeError, json.JSONDecodeError):
                return self._send(400, "{\"text\": \"Ungueltiger Befehl.\"}".encode(), "application/json")
            return self._send(200, json.dumps({"id": ctl["submit"](cmd)}).encode(), "application/json")

        def log_message(self, *args):  # keine Zugriffszeilen im Bot-Log
            pass

    return Handler


def serve(folder, port: int, snapshot_file: str = "mt5bot_snapshot.json", open_browser: bool = True, lan: bool = False,
          control: str = "off", submit=None, results=None, symbols=None) -> dict:
    folder = Path(folder)
    key = load_key(folder) if lan else None
    host = "0.0.0.0" if lan else "127.0.0.1"
    phone_urls: list[str] = []
    server = ThreadingHTTPServer((host, port), make_handler(folder, snapshot_file, key, phone_urls, {"mode": control, "submit": submit, "results": results, "symbols": symbols}))
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
