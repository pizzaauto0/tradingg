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


def make_handler(folder: Path, snapshot_file: str, key: str | None, phone_urls: list[str]):
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

        def do_GET(self):  # noqa: N802 (Name von http.server vorgegeben)
            url = urlparse(self.path)
            if not self._local():
                given = parse_qs(url.query).get("key", [""])[0]
                if not key or not hmac.compare_digest(given, key):
                    return self._send(403, "Zugriff verweigert: Link mit gültigem Schlüssel nötig.".encode(), "text/plain; charset=utf-8")
            if url.path in ("/", "/index.html"):
                return self._send(200, WEB.read_bytes(), "text/html; charset=utf-8")
            if url.path == "/api/snapshot":
                f = folder / snapshot_file
                if not f.exists():
                    return self._send(503, b'{"error": "Noch kein Datenstand - laeuft der Bot?"}', "application/json")
                return self._send(200, f.read_bytes(), "application/json")
            if url.path == "/api/phone" and self._local():  # Handy-Link nur am PC selbst anzeigen
                return self._send(200, json.dumps({"urls": phone_urls}).encode(), "application/json")
            return self._send(404, b"nicht gefunden", "text/plain; charset=utf-8")

        def log_message(self, *args):  # keine Zugriffszeilen im Bot-Log
            pass

    return Handler


def serve(folder, port: int, snapshot_file: str = "mt5bot_snapshot.json", open_browser: bool = True, lan: bool = False) -> dict:
    folder = Path(folder)
    key = load_key(folder) if lan else None
    host = "0.0.0.0" if lan else "127.0.0.1"
    phone_urls: list[str] = []
    server = ThreadingHTTPServer((host, port), make_handler(folder, snapshot_file, key, phone_urls))
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
