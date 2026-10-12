"""Lokale Oberfläche des MT5-Bots: liefert web/index.html und den Datenstand (mt5bot_snapshot.json) aus.

Nur lesend und nur unter 127.0.0.1 erreichbar (nicht aus dem Netzwerk). Der Bot startet sie automatisch (DASHBOARD_PORT);
einzeln: python -m mt5bot.dashboard
"""
from __future__ import annotations

import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

WEB = Path(__file__).parent / "web" / "index.html"


def make_handler(folder: Path, snapshot_file: str):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, code: int, body: bytes, ctype: str) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802 (Name von http.server vorgegeben)
            path = self.path.split("?")[0]
            if path in ("/", "/index.html"):
                return self._send(200, WEB.read_bytes(), "text/html; charset=utf-8")
            if path == "/api/snapshot":
                f = folder / snapshot_file
                if not f.exists():
                    return self._send(503, b'{"error": "Noch kein Datenstand - laeuft der Bot?"}', "application/json")
                return self._send(200, f.read_bytes(), "application/json")
            return self._send(404, b"nicht gefunden", "text/plain; charset=utf-8")

        def log_message(self, *args):  # keine Zugriffszeilen im Bot-Log
            pass

    return Handler


def serve(folder, port: int, snapshot_file: str = "mt5bot_snapshot.json", open_browser: bool = True) -> str:
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(Path(folder), snapshot_file))
    threading.Thread(target=server.serve_forever, daemon=True, name="dashboard").start()
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    if open_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    return url


if __name__ == "__main__":
    import time

    from . import config

    print("Oberfläche:", serve(".", config.DASHBOARD_PORT or 8765, config.SNAPSHOT_FILE), "– beenden mit Strg+C")
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass
