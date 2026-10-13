"""Telegram-Steuerung, Auswertung, Wiederverbindung und Autostart des MT5-Bots – ohne Netzwerk und ohne MetaTrader."""
import json
import time
from collections import namedtuple
from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

from mt5bot import history
from mt5bot.runner import Runner
from mt5bot.telegram import MAX_AGE_SECONDS, TelegramBridge, chunks, load_credentials
from tests.test_mt5bot import FakeMT5, Pos, bars, cfg, run_signal, signal_series


class FakeApi:
    def __init__(self):
        self.sent = []

    def call(self, method, params=None, timeout=0):
        if method == "sendMessage":
            self.sent.append(params["text"])
        return {"ok": True, "result": []}


def bridge(runner, chat="42"):
    api = FakeApi()
    tg = TelegramBridge(runner, api, chat, sync=True)
    runner.tg = tg
    return tg, api


def say(tg, text, chat="42", age=0):
    tg.ingest({"update_id": 1, "message": {"chat": {"id": int(chat)}, "text": text, "date": int(time.time()) - age}})
    tg.process()


def test_unauthorized_chat_gets_only_its_own_id_and_cannot_control(tmp_path):
    r, mt5 = run_signal(tmp_path)
    tg, api = bridge(r)
    say(tg, "/closeall", chat="99")
    say(tg, "/ja", chat="99")
    assert len(mt5.positions) == 1                      # nichts passiert
    assert len(api.sent) == 1 and "99" in api.sent[0] and "Nicht berechtigt" in api.sent[0]
    say(tg, "/status", chat="99")
    assert len(api.sent) == 1                           # nur einmal geantwortet


def test_old_messages_are_ignored(tmp_path):
    r, mt5 = run_signal(tmp_path)
    tg, api = bridge(r)
    say(tg, "/closeall", age=MAX_AGE_SECONDS + 30)   # alte Nachricht: wird nicht einmal beachtet
    assert tg.inbox.empty() and not api.sent and tg.pending is None
    say(tg, "/ja")
    assert len(mt5.positions) == 1 and "Nichts zu bestätigen" in api.sent[-1]


def test_view_commands(tmp_path):
    r, mt5 = run_signal(tmp_path)
    tg, api = bridge(r)
    say(tg, "/status")
    assert "DEMO" in api.sent[-1] and "Kapital 10000.00" in api.sent[-1] and "erlaubt" in api.sent[-1]
    say(tg, "/trades")
    t = mt5.positions[0].ticket
    assert f"#{t} XAUUSD LONG" in api.sent[-1] and "SL" in api.sent[-1]
    say(tg, f"/trade {t}")
    assert "WARUM GEKAUFT" in api.sent[-1] and "Frage 1" in api.sent[-1]
    say(tg, "/markets")
    assert "XAUUSD H4" in api.sent[-1]
    say(tg, "/log")
    assert "KAUF" in api.sent[-1]
    say(tg, "/stats")
    say(tg, "/hilfe")
    assert "Unbekannter Befehl" in api.sent[-1]
    say(tg, "/help")
    assert "/closeall" in api.sent[-1]


def test_close_needs_confirmation_and_is_recorded(tmp_path):
    r, mt5 = run_signal(tmp_path)
    tg, api = bridge(r)
    t = mt5.positions[0].ticket
    say(tg, f"/close {t}")
    assert "Bestätigen mit /ja" in api.sent[-1] and len(mt5.positions) == 1
    say(tg, "/nein")
    assert len(mt5.positions) == 1
    say(tg, f"/close {t}")
    say(tg, "/ja")
    assert not mt5.positions and "geschlossen" in api.sent[-1]
    rows = history.read_trades(tmp_path)
    assert len(rows) == 1 and rows[0]["close_reason"] == "Telegram /close" and rows[0]["profile"] == "video" and rows[0]["r"] is not None
    assert "Frage 1" in rows[0]["open_reason"]
    say(tg, "/ja")
    assert "Nichts zu bestätigen" in api.sent[-1]


def test_confirmation_expires(tmp_path):
    r, mt5 = run_signal(tmp_path)
    tg, api = bridge(r)
    say(tg, f"/close {mt5.positions[0].ticket}")
    tg.pending["expires"] = time.time() - 1
    say(tg, "/ja")
    assert len(mt5.positions) == 1


def test_pause_resume_kill(tmp_path):
    r, mt5 = run_signal(tmp_path)
    tg, api = bridge(r)
    say(tg, "/pause")
    assert r.state["paused"] and "PAUSIERT" in api.sent[-1]
    say(tg, "/status")
    assert "PAUSIERT" in api.sent[-1]
    say(tg, "/resume")
    assert not r.state["paused"]
    say(tg, "/kill")
    say(tg, "/ja")
    assert not mt5.positions and r.state["paused"] and "NOT-AUS" in api.sent[-1]


def test_manual_buy_sell_with_confirmation_and_limits(tmp_path):
    r, mt5 = run_signal(tmp_path)
    mt5.positions.clear()
    tg, api = bridge(r)
    say(tg, "/buy XAUUSD 0.5")
    assert "XAUUSD eröffnen" in api.sent[-1] and "Stop" in api.sent[-1] and not mt5.positions
    say(tg, "/ja")
    p = mt5.positions[0]
    assert p.magic == 100900 and p.sl > 0 and p.tp > 0 and p.sl < p.price_open < p.tp
    say(tg, "/trades")
    assert "manuell (Telegram)" in api.sent[-1]
    say(tg, "/sell XAUUSD")
    say(tg, "/ja")
    assert len(mt5.positions) == 2 and mt5.positions[1].tp < mt5.positions[1].price_open < mt5.positions[1].sl
    say(tg, "/buy GOLDXYZ")
    assert "nicht verfügbar" in api.sent[-1]
    say(tg, "/buy XAUUSD 5")
    assert "höchstens 2" in api.sent[-1]
    say(tg, "/closeall")
    say(tg, "/ja")
    assert not mt5.positions                               # auch manuelle Trades zählen als eigene


def test_manual_open_respects_position_and_daily_limit(tmp_path):
    r, mt5 = run_signal(tmp_path, c=cfg(MAX_OPEN_POSITIONS=1))
    tg, api = bridge(r)
    say(tg, "/buy XAUUSD")
    assert "Maximal 1 Positionen" in api.sent[-1] and len(mt5.positions) == 1
    mt5.positions.clear()
    mt5.equity = 10_000 * 0.9
    say(tg, "/buy XAUUSD")
    assert "Tagesverlust-Limit" in api.sent[-1]


def test_notifications_for_buy_and_close(tmp_path):
    series = signal_series()
    mt5 = FakeMT5({"XAUUSD": bars(series + [series[-1]])})
    r = Runner(mt5, cfg(), tmp_path)
    r.connect()
    tg, api = bridge(r)
    mt5.n = len(series)
    r.step()
    mt5.n += 1
    r.step()
    assert any(m.startswith("KAUF") and "Frage 1" in m for m in api.sent)
    mt5.positions.clear()                                   # Broker schließt (Stop)
    r.track_positions()
    assert any(m.startswith("VERKAUF") for m in api.sent)
    assert any(m.startswith("KEIN KAUF") for m in api.sent) is False  # keine Spam-Nachrichten


def test_credentials_from_file_and_env(tmp_path, monkeypatch):
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    monkeypatch.delenv("TELEGRAM_CHAT_ID", raising=False)
    assert load_credentials(tmp_path) == (None, None)
    (tmp_path / "mt5bot_telegram.json").write_text(json.dumps({"token": "1:abc", "chat_id": 42}))
    assert load_credentials(tmp_path) == ("1:abc", "42")
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "9:zzz")
    assert load_credentials(tmp_path)[0] == "9:zzz"


def test_long_messages_are_chunked():
    text = "\n".join("x" * 100 for _ in range(100))
    parts = chunks(text, 1000)
    assert len(parts) > 1 and all(len(p) <= 1000 for p in parts) and "".join(parts) == text


def test_history_stats_periods_and_equity(tmp_path):
    now = datetime.now(timezone.utc)
    for i, (pnl, r_) in enumerate([(100, 1.0), (-50, -1.0), (200, 2.0)]):
        history.append_trade(tmp_path, {"opened": now.isoformat(), "closed": (now - timedelta(hours=i)).isoformat(), "profile": "video" if i < 2 else "connors",
                                        "symbol": "XAUUSD", "pnl": pnl, "r": r_})
    ts = history.read_trades(tmp_path)
    st = history.stats(ts)
    assert st["all"]["trades"] == 3 and st["all"]["wins"] == 2 and abs(st["all"]["profit_factor"] - 6.0) < 1e-9 and abs(st["all"]["avg_r"] - 2 / 3) < 1e-9
    assert st["profiles"]["video"]["trades"] == 2 and st["profiles"]["connors"]["pnl"] == 200
    pr = history.periods(ts)
    assert pr["month"] == 250 and pr["months"][0]["n"] == 3
    for i in range(1000):
        history.append_equity(tmp_path, now - timedelta(minutes=5 * (1000 - i)), 10_000 + i)
    eq = history.read_equity(tmp_path, max_points=100)
    assert len(eq) <= 101 and eq[-1][1] == 10_999
    assert history.summary(tmp_path)["stats"]["all"]["trades"] == 3


def test_history_endpoint(tmp_path):
    import urllib.request

    from mt5bot.dashboard import serve
    history.append_trade(tmp_path, {"closed": datetime.now(timezone.utc).isoformat(), "profile": "video", "symbol": "XAUUSD", "pnl": 10, "r": 0.5})
    info = serve(tmp_path, 0, open_browser=False)
    try:
        d = json.loads(urllib.request.urlopen(info["local"] + "api/history").read())
        assert d["stats"]["all"]["trades"] == 1 and d["trades"][0]["symbol"] == "XAUUSD"
    finally:
        info["server"].shutdown()


def test_reconnect_when_terminal_drops(tmp_path):
    series = signal_series()
    mt5 = FakeMT5({"XAUUSD": bars(series + [series[-1]])})
    r = Runner(mt5, cfg(), tmp_path)
    r.connect()
    mt5.n = len(series)
    calls = {"init": 0}
    mt5.account_info = lambda: None                       # Verbindung weg
    mt5.initialize = lambda **kw: calls.__setitem__("init", calls["init"] + 1) or False
    with pytest.raises(RuntimeError, match="nicht erreichbar"):
        r.step()
    assert calls["init"] == 1
    r.step() if False else None
    acc = FakeMT5({}).account_info
    mt5.account_info = acc
    mt5.initialize = lambda **kw: True
    r._last_reconnect = -1e9
    r.step()                                              # wieder da: läuft normal weiter


def test_autostart_install_remove(tmp_path, monkeypatch):
    from mt5bot import autostart
    monkeypatch.setenv("APPDATA", str(tmp_path))
    f = autostart.install()
    text = f.read_text(encoding="utf-8")
    assert f.parent == autostart.startup_dir() and "run_forever.bat" in text and "WScript.Shell" in text and ', 7, False' in text
    assert 'cmd /c ""' in text.replace('""', '""')
    assert autostart.remove() and not f.exists() and not autostart.remove()
