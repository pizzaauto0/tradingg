"""Konfiguration des MT5-Bots. Mehrere Profile laufen in EINEM Prozess über EINE Verbindung zum MetaTrader-5-Terminal.

Jedes Profil hat eine eigene Magic Number (so erkennt der Bot seine Orders) und eigene Märkte. Gemeinsam gelten die
Sicherheitsgrenzen unten (nur Demo-Konto, maximale Positionen, Tagesverlust-Limit, Kill-Switch-Datei).
Nicht von Hand ändern, was du nicht verstehst: Risiko bleibt bei 1 % je Trade, jeder Trade hat Stop-Loss UND Take-Profit.
"""

# --- Sicherheit (gilt für alle Profile) ---
ALLOW_REAL_ACCOUNT = False     # NIEMALS leichtfertig auf True setzen: der Bot startet dann auch auf Echtgeld-Konten
MAX_OPEN_POSITIONS = 3         # gesamt, über alle Profile (Metalle sind korreliert: 3 Metall-Trades = 3x dasselbe Risiko)
DAILY_LOSS_LIMIT_PCT = 3.0     # Tagesverlust in % des Tagesanfangs-Kapitals -> keine neuen Trades bis zum nächsten UTC-Tag
KILL_FILE = "KILL_SWITCH"      # existiert diese Datei im Ordner: keine neuen Trades, offene Positionen werden geschlossen

# --- Login (leer lassen, wenn das MT5-Terminal schon eingeloggt ist) ---
MT5_LOGIN = None               # z. B. 12345678
MT5_PASSWORD = None
MT5_SERVER = None              # z. B. "MetaQuotes-Demo"

# --- Telegram (Token und Chat-ID NICHT hier eintragen: python -m mt5bot.telegram_setup speichert sie in mt5bot_telegram.json) ---
TELEGRAM_ENABLED = True
TELEGRAM_NOTIFY = ("KAUF", "VERKAUF", "FEHLER", "LIMIT", "BLOCKIERT")   # diese Ereignisse kommen sofort aufs Handy
TELEGRAM_REPORT_HOURS = 6      # alle X Stunden Kurzbericht (Status + offene Trades); 0 = aus

# --- Manuell eröffnen per Telegram (/buy, /sell): eigene Magic Number, immer mit Stop-Loss und Take-Profit ---
MANUAL = {"enabled": True, "magic": 100900, "timeframe": "H4", "risk_percent": 0.5, "atr_stop_mult": 2.0, "rr": 2.0,
          "symbols": []}       # zusätzliche Symbole, die du manuell handeln willst (neben denen deiner Profile)

# --- Technik ---
MT5_TERMINAL_PATH = None       # z. B. r"C:\Program Files\MetaTrader 5\terminal64.exe": startet das Terminal selbst (nützlich für den Autostart)
DASHBOARD_OPEN_BROWSER = True  # Browser beim Start öffnen (beim Autostart sinnvollerweise False)
BARS_HISTORY = 600             # so viele Kerzen je Markt für die Berechnung
POLL_SECONDS = 30
HEARTBEAT_MINUTES = 15         # Lebenszeichen + Marktzustand im Log
LOG_FILE = "mt5bot.log"
LOG_DIR = "logs"               # Ordner für Protokolle: entscheidungen_<Datum>.log und bericht_<Datum>.txt
REPORT_MINUTES = 60            # alle X Minuten ein ausführlicher Bericht (Konto, Positionen mit Begründung, Ereignisse, Marktanalyse)
JOURNAL_FILE = "mt5bot_journal.csv"
STATE_FILE = "mt5bot_state.json"
SNAPSHOT_FILE = "mt5bot_snapshot.json"   # Datenstand für die Oberfläche
DASHBOARD_PORT = 8765                     # Oberfläche unter http://127.0.0.1:8765 (0 = aus)
DASHBOARD_CONTROL = "local"               # Klick-Steuerung im Portal: "local" = nur am PC selbst, "phone" = auch vom Handy (jeder mit dem Link kann dann
                                          # Trades eröffnen/schließen!), "off" = Portal nur zum Ansehen
DASHBOARD_PHONE = True                    # True: auch vom Handy im gleichen WLAN erreichbar – NUR mit geheimem Schlüssel im Link
                                          # (steht beim Start im Log und auf der Seite am PC). False: nur dieser PC.

# Andere Bots, die auf demselben Konto laufen (Magic Number -> Name), damit die Oberfläche ihre Positionen benennen kann
KNOWN_BOTS = {100001: "1-Haupt-Bot", 100002: "2-David-V2", 100003: "3-Divergenz-Gold-Silber"}

# Zusätzlich probiert der Bot jeden Namen mit diesen Endungen (viele Broker hängen z. B. "m", ".a" oder ".US" an):
SYMBOL_SUFFIXES = ["", ".a", "m", ".r", ".pro", ".cash", ".US", ".us", "+"]

# Manche Broker nennen Symbole anders (z. B. GOLD statt XAUUSD): der Bot probiert diese Namen der Reihe nach.
SYMBOL_ALIASES = {
    "XAUUSD": ["XAUUSD", "GOLD", "XAUUSD.a", "XAUUSDm"],
    "XAGUSD": ["XAGUSD", "SILVER", "XAGUSD.a", "XAGUSDm"],
    "XPTUSD": ["XPTUSD", "PLATINUM", "XPTUSDm"],
    "XCUUSD": ["XCUUSD", "COPPER", "COPPER-C", "HG"],
    "USOIL": ["USOIL", "XTIUSD", "WTI", "CL-OIL", "USOUSD", "OIL"],
    "NATGAS": ["NATGAS", "XNGUSD", "NGAS", "NG-C"],
    "US500": ["US500", "SPX500", "SP500", "US500.cash", "USA500"],
    "USTEC": ["USTEC", "NAS100", "US100", "NDX100", "USTEC.cash"],
    "US30": ["US30", "DJ30", "WS30", "DJI30", "US30.cash"],
    "US2000": ["US2000", "RUSSELL2000", "RTY", "US2000.cash"],
    "DE40": ["DE40", "GER40", "GER30", "DAX40", "DE30"],
    "JP225": ["JP225", "NIKKEI225", "JPN225", "NI225"],
}

# --- Profile ---
# strategy: entweder {"type": <Typ aus tradingbot/strategies.py>, "params": {...}}  (alle 27 Typen der Bibliothek, dieselben
#           Regeln wie in den Massen-Tests) oder {"type": "rsi_pullback", ...} / {"type": "gold_silver_divergence", ...}
#           (die Strategien der drei Beispiel-Bots).
# Stop-Loss = ATR(14) x atr_stop_mult, Take-Profit = rr x Stop-Abstand. Ausstieg zusätzlich, wenn die Strategie ein Ausstiegssignal gibt.
PROFILES = [
    {
        "name": "video", "enabled": True, "magic": 100101,
        "markets": {"XAUUSD": "H4", "XAGUSD": "H4", "XPTUSD": "H4"},
        "strategy": {"type": "ma_pullback", "params": {"ma_period": 50, "slope_bars": 10, "touch_pct": 0.5, "exit_pct": 3.0}},
        "allow_short": False, "risk_percent": 1.0, "atr_stop_mult": 2.0, "rr": 2.0,
        "breakeven_at_r": None,   # z. B. 1.0: ab +1R Stop auf Einstand ziehen ("Trail: BE"); None = aus (so getestet)
        "max_days": None,         # z. B. 40: Position nach 40 Tagen schließen (Zeit-Stopp); None = aus
    },
    {
        "name": "connors_d1", "enabled": False, "magic": 100102,
        "markets": {"XAUUSD": "D1"},
        "strategy": {"type": "connors_rsi2", "params": {"trend": 200, "rsi_period": 2, "oversold": 10, "exit_ma": 5}},
        "allow_short": False, "risk_percent": 1.0, "atr_stop_mult": 2.0, "rr": 2.0,
    },
    {   # Strategie des Beispiel-Bots "1-Haupt-Bot": Kurs über EMA, RSI kreuzt von unten über die Schwelle
        "name": "haupt_rsi", "enabled": False, "magic": 100001,
        "markets": {"XAUUSD": "H1", "XAGUSD": "H1", "XPTUSD": "H1", "USDJPY": "H4"},
        "strategy": {"type": "rsi_pullback", "params": {"trend_len": 150, "rsi_len": 14, "oversold": 35, "buffer_atr": 0.0}},
        "allow_short": False, "risk_percent": 1.0, "atr_stop_mult": 2.0, "rr": 2.0,
    },
    {   # Strategie des Beispiel-Bots "2-David-V2": wie oben, mit Neutralzone und Short
        "name": "david_v2", "enabled": False, "magic": 100002,
        "markets": {"EURUSD": "H1", "GBPUSD": "H1", "USDJPY": "H1", "XAUUSD": "H4"},
        "strategy": {"type": "rsi_pullback", "params": {"trend_len": 200, "rsi_len": 14, "oversold": 35, "buffer_atr": 0.25}},
        "allow_short": True, "risk_percent": 0.5, "atr_stop_mult": 1.5, "rr": 2.0,
    },
    {   # Strategie des Beispiel-Bots "3-Divergenz-Gold-Silber": Gold fällt gegenüber Silber zurück und holt auf
        "name": "divergenz", "enabled": False, "magic": 100003,
        "markets": {"XAUUSD": "H4"},
        "strategy": {"type": "gold_silver_divergence", "params": {"reference": "XAGUSD", "trend_len": 150, "ret_len": 20,
                                                                    "band_lookback": 100, "band_mult": 1.5}},
        "allow_short": False, "risk_percent": 1.0, "atr_stop_mult": 2.0, "rr": 2.0,
    },
]
