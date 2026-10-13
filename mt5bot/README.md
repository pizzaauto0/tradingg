# MT5-Bot (Python, Demo-Konto)

Verbindet sich über das Paket `MetaTrader5` mit deinem laufenden MetaTrader-5-Terminal (nur Windows) und führt **mehrere Profile in einem Prozess** aus.
Aufgebaut nach dem Muster deiner drei Beispiel-Bots (Haupt-Bot, David V2, Divergenz Gold/Silber), die alle als Profil enthalten sind.

## Start
```
pip install MetaTrader5 pandas numpy pyyaml
python -m mt5bot.run          (im Projektordner)   oder   mt5bot\start_bot.bat
```
Vorher: MetaTrader 5 starten, **Demo-Konto** einloggen, oben „Algo-Handel" grün. Stoppen mit Strg+C (Stop-Loss/Take-Profit bleiben beim Broker).

## Oberfläche
Der Bot öffnet beim Start automatisch **http://127.0.0.1:8765** im Browser (nur auf diesem PC erreichbar, nur lesend):
Kopfzeile mit Uhrzeit Deutschland/New York, Kapital, Tagesgewinn, letztem Durchlauf, nächster Kerze, Broker-Status;
je offener Position eine Karte mit Kerzenchart, Einstieg, Stop, Ziel, 52-Wochen-Hoch, R-Vielfaches (Gewinn in Einheiten des
Anfangsrisikos), Prozent, Tagen und MaxR (bestes R seit Einstieg); darunter der Zustand jedes Marktes. Aktualisiert alle 15 s.
Optional je Profil: `breakeven_at_r` (Stop ab +xR auf Einstand, Anzeige „Trail: BE") und `max_days` (Zeit-Stopp).
Die Oberfläche zeigt **alle Positionen des Kontos**: eigene Profile, deine anderen Bots (Name über `KNOWN_BOTS` bzw. die Magic Number, Schild in Orange) und manuelle Trades. Verwaltet und geschlossen werden nur die eigenen.

**Auf dem Handy:** Mit `DASHBOARD_PHONE = True` steht beim Start im Log (und oben auf der Seite am PC) ein Link wie `http://192.168.x.x:8765/?key=...`.
Handy im **gleichen WLAN** → Link öffnen. Windows fragt beim ersten Start nach der Firewall: „Private Netzwerke" erlauben.
Unterwegs: **Tailscale** (kostenlos) auf PC und Handy installieren und gleich anmelden, dann den Link mit der Tailscale-Adresse (100.x.x.x) öffnen.
Keine Portfreigabe im Router einrichten – die Seite ist unverschlüsselt (HTTP) und gehört nicht offen ins Internet.
Ohne Schlüssel kommt niemand hinein; Schlüssel ändern: `mt5bot_dashboard_key.txt` löschen und Bot neu starten.

Einzeln starten (wenn der Bot schon läuft): `python -m mt5bot.dashboard`. Port ändern/abschalten: `DASHBOARD_PORT` in der Konfiguration.

## Profile (`mt5bot/config.py`, `enabled` ein-/ausschalten)
| Profil | Strategie | Standard |
|---|---|---|
| `video` | Video-Methode: Linie steigt + Rücksetzer bis zur Linie (`ma_pullback`, 50/10) auf XAUUSD, XAGUSD, XPTUSD H4 | **an** |
| `connors_d1` | Connors RSI(2) auf Gold D1 | aus |
| `haupt_rsi` | wie 1-Haupt-Bot: Kurs über EMA150, RSI(14) kreuzt über 35 | aus |
| `david_v2` | wie 2-David-V2: mit Neutralzone, Long **und** Short, 0,5 % Risiko | aus |
| `divergenz` | wie 3-Divergenz: Gold fällt gegenüber Silber zurück und holt auf | aus |

Jedes Profil kann auch jede andere der 27 Strategie-Typen aus `tradingbot/strategies.py` nutzen (`{"type": ..., "params": ...}`) – dieselbe Logik wie in den Massen-Tests.
Jedes Profil braucht eine **eigene Magic Number**; so verwalten mehrere Profile (und andere Bots auf demselben Konto) nur ihre eigenen Positionen.

## Sicherheit (gemeinsam für alle Profile)
- **Nur Demo-Konten** (`ALLOW_REAL_ACCOUNT = False`): auf Echtgeld bricht der Bot beim Start ab.
- Jeder Trade hat **Stop-Loss und Take-Profit**; ein Wächter rüstet fehlenden Schutz nach oder schließt die Position sofort.
- Lotgröße über `order_calc_profit` des Brokers (1 % Risiko, höchstens 2 % erlaubt, abgerundet; Abbruch, wenn das Mindest-Lot zu riskant wäre).
- Gesamt höchstens `MAX_OPEN_POSITIONS`, je Profil und Markt eine Position; **Tagesverlust-Limit** (3 %); **Kill-Switch**: Datei `KILL_SWITCH` im Projektordner anlegen → alle Positionen schließen, keine neuen Trades.
- Entscheidung nur bei neu geschlossenen Kerzen; beim Start keine Alt-Signale.
- Journal `mt5bot_journal.csv`, Log `mt5bot.log`, Lebenszeichen mit Marktzustand alle 15 Minuten.

## Telegram: Trades ansehen, schließen, eröffnen
**Einrichten (einmalig):** In Telegram `@BotFather` → `/newbot` → du bekommst einen Token. Dann im Projektordner `python -m mt5bot.telegram_setup`:
Token eingeben (Eingabe unsichtbar), dem neuen Bot eine Nachricht schicken – das Programm findet deine Chat-ID selbst und speichert beides in `mt5bot_telegram.json` (nur lokal).
Den Token nie in Chats posten; bei Verdacht in `@BotFather` → `/revoke`. Bot neu starten.

| Befehl | Wirkung |
|---|---|
| `/status` `/trades` `/trade <Nr>` | Konto, alle offenen Trades, ein Trade mit Begründung („warum gekauft") |
| `/markets` `/stats` `/log` `/report` | Zustand der Märkte, Kennzahlen (Woche/Monat/je Profil), letzte Ereignisse, Bericht jetzt |
| `/close <Nr>` `/closeall` `/kill` | Schließen – **jeweils mit `/ja` bestätigen** (60 s gültig), `/nein` bricht ab |
| `/buy <Symbol> [Risiko%]` `/sell …` | Manuell eröffnen mit Stop und Ziel (ATR-basiert), Vorschau mit Lotgröße, dann `/ja` |
| `/pause` `/resume` | Keine neuen automatischen Trades / wieder erlauben |

Automatisch aufs Handy: jeder Kauf (mit den ✔/✘-Bedingungen), jeder Verkauf (mit Grund und Ergebnis), Fehler, Limits, alle 6 Stunden ein Kurzbericht (`TELEGRAM_REPORT_HOURS`).
Sicherheit: antwortet nur auf deine Chat-ID, alte Nachrichten aus der Zeit vor dem Start werden ignoriert, manuelle Trades respektieren Positions- und Tageslimit und das 2-%-Risikomaximum.
`/sell` neben einem offenen Kauf im selben Markt braucht ein **Hedging-Konto** (bei Netting-Konten würde es die Position verringern statt eine zweite zu öffnen).

## Autostart (Windows)
`python -m mt5bot.autostart install` – legt im Autostart-Ordner eine Startdatei an (kein Administrator nötig). Beim Anmelden startet der Bot minimiert,
**startet nach Abstürzen automatisch neu** und verbindet sich neu, wenn MetaTrader kurz wegbricht. `status` zeigt den Zustand, `remove` entfernt es.
Trage in `config.py` bei `MT5_TERMINAL_PATH` den Pfad zu `terminal64.exe` ein, dann startet der Bot MetaTrader selbst.
Voraussetzungen: Windows meldet dich nach einem Neustart automatisch an, der PC geht nicht in den Ruhezustand (Einstellungen → System → Netzbetrieb: „Nie"). Für echten 24/7-Betrieb: Windows-VPS.
Bei einem Sicherheitsstopp (Echtgeld-Konto erkannt) startet der Bot bewusst nicht neu; Neustarts stehen in `logs/neustarts.log`.

## Auswertung im Portal
Unter „Kapital & Ergebnis": Kapitalkurve (Messpunkt alle 5 Minuten, 7 Tage / 30 Tage / alles), Ergebnis heute/Woche/Monat, Trefferquote, Profitfaktor, Ø R,
Kennzahlen je Profil und die Liste der abgeschlossenen Trades (mit R, Ergebnis, Dauer, Grund). Daten: `mt5bot_trades.csv`, `mt5bot_equity.csv`. Telegram `/stats` zeigt dasselbe.

## Protokolle: warum gekauft, warum nicht
Im Ordner `logs/` (im Projektordner) schreibt der Bot von selbst:
- **`entscheidungen_<Datum>.log`** – jede ausgewertete Kerze: Kauf, **kein Kauf mit den nicht erfüllten Bedingungen** (✔/✘ je Bedingung mit den echten Zahlen), blockierte Signale (Positionslimit, Tageslimit), Order-Fehler, Verkäufe (Ausstiegssignal, Stop-Loss, Take-Profit, Kill-Switch) und Tageslimit-Ereignisse.
- **`bericht_<Datum>.txt`** – **alle 60 Minuten** (und beim Start) ein ausführlicher Bericht: 1. Konto und Zustand, 2. offene Positionen mit **„WARUM GEKAUFT“** (die Begründung bleibt auch nach einem Neustart erhalten), 3. Ereignisse seit dem letzten Bericht, 4. Marktanalyse jetzt (warum würde er kaufen / warum nicht), nächste Kerze.
Zusätzlich wie bisher `mt5bot_journal.csv` (Trades) und `mt5bot.log`. Intervall: `REPORT_MINUTES`, Ordner: `LOG_DIR` in der Konfiguration.
Die Dateien sind reiner Text (UTF-8) – im Editor öffnen oder hier einfügen, wenn du mit mir die Ergebnisse auswerten willst.

## Symbolnamen
Manche Broker nennen Gold `GOLD` statt `XAUUSD`: `SYMBOL_ALIASES` in der Konfiguration wird der Reihe nach probiert; was nicht gefunden wird, wird übersprungen.

## Getestet?
Mit einer Attrappe des MetaTrader5-Moduls (`tests/test_mt5bot.py`): Signal → Order mit Schutz und Risikogrenze, Echtgeld-Sperre, Positions-/Tageslimit, Kill-Switch, Schutz-Wächter. Gegen ein echtes Terminal und einen echten Broker wurde es noch **nicht** ausgeführt.
