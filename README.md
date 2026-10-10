# Modularer Trading-Bot (Krypto, ccxt, Paper-Modus als Standard)

Analysiert den Markt, testet Strategien im Backtest und handelt nur mit Strategien, die vorgegebene
Mindestwerte erreichen. **Standard ist Paper-Trading** – echte Orders gibt es nur mit `live_trading: true`.

> **Keine Anlageberatung, keine Gewinngarantie.** Ein bestandener Backtest sagt nichts Verlässliches über die
> Zukunft. Erst wochenlang im Paper-Modus laufen lassen, live nur mit einem Betrag starten, dessen Verlust du verkraftest.

## Annahmen (die Platzhalter aus der Aufgabe)
Alles in `config.yaml` änderbar: Krypto · Kraken (ccxt) · 15-Minuten-Kerzen/Daytrading · 1000 USD ·
1 % Risiko pro Trade · 5 % Tagesverlust-Limit · max. 2 offene Positionen · BTC/USD und ETH/USD · Long-only (Spot).

## Ordnerstruktur
```
main.py                CLI: research | run | status | kill
config.yaml            gesamte Konfiguration
requirements.txt
.env.example           Vorlage für API-Keys (Umgebungsvariablen)
tradingbot/
  data.py              1 Marktdaten (ccxt: Live-Kurse, Historie mit Paginierung)
  analysis.py          2 Indikatoren + Marktzustand (Trend/Seitwärts, Volatilität, Volumen)
  strategies.py        Strategie-Bausteine (MA-Crossover, RSI, Breakout, Bollinger) mit validierten Parametern
  research.py          3 LLM-Recherche -> Kandidaten (nur JSON-Spezifikationen)
  backtest.py          4 Backtester (Gebühren, Slippage, Out-of-Sample) + Mindestwerte
  selector.py          5 Strategie-Auswahl je Marktphase
  execution.py         6 PaperBroker / LiveBroker (Stop-Loss immer dabei)
  risk.py              7 Risikomanagement, Tageslimit, Kill Switch
  tradelog.py, notify.py   8 Logdatei, SQLite-Trade-Log mit Begründung, Telegram
  pipeline.py          Recherche -> Backtest -> Zulassung
  solana_broker.py     Solana-Wallet über Jupiter (optional)
  engine.py            Hauptschleife
tests/                 pytest (34 Tests, ohne Netzwerk)
```

## Schnellstart (Paper-Modus)
```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

python main.py research     # optional: Strategien testen, Tabelle ansehen (braucht Internet, keine Keys)
python main.py run          # Bot starten (macht "research" automatisch, falls keine aktuellen Zulassungen existieren)
python main.py status       # Positionen, Tageslimit, letzte Trades
python main.py kill         # Not-Aus
pytest                      # Tests
```
Ergebnisse liegen in `data/`: `bot.log`, `trades.db` (SQLite, Tabelle `trades` mit Spalte `reason`),
`strategies/approved.json` und `strategies/backtest_report.json`, Zustand in `state_paper.json`.

## Ablauf
1. **Pipeline** (beim Start und alle `revalidate_hours`): Historie laden → Kandidaten (Standardstrategien, optional LLM) →
   Backtest je Symbol mit Gebühren/Slippage → nur Strategien über allen Mindestwerten (`backtest:` in der Config:
   Trades, Rendite, Max Drawdown, Sharpe, Trefferquote, Profit Factor, Out-of-Sample-Rendite) werden zugelassen.
2. **Pro neuer geschlossener Kerze**: Marktzustand bestimmen → unter den zugelassenen Strategien die mit dem besten
   Sharpe wählen, die zur Marktphase passt → Signal → Risiko-Check → Position mit Stop-Loss eröffnen.
   Der Backtester handelt nur in den Marktphasen, für die die Strategie gedacht ist, und nutzt dieselbe
   Stop-/Größenlogik wie der Live-Betrieb. Ist die Phase ein Abwärtstrend, handelt standardmäßig keine Strategie.
3. **Laufend** (alle `poll_seconds`): Stop-Loss, Take-Profit und Ausstiegssignale prüfen.

## Risikomanagement (Vorrang vor allem)
- Positionsgröße so, dass ein Stop-Out inkl. Gebühren/Slippage höchstens `risk_per_trade_pct` (max. erlaubt: 2 %) kostet;
  zusätzlich Deckel `max_position_pct`, kein Hebel.
- `max_daily_loss_pct`: wird er (Eigenkapital inkl. offener Positionen, UTC-Tag) erreicht, werden Positionen geschlossen
  und bis zum nächsten UTC-Tag keine neuen eröffnet.
- `max_open_positions`.
- **Kill Switch**: `python main.py kill` legt die Datei `KILL_SWITCH` an. Der laufende Bot schließt alle Positionen
  und beendet sich. Läuft er nicht, schließt der nächste Start zuerst alles. Danach die Datei löschen.
- Live wird der Stop-Loss als Stop-Order an der Börse hinterlegt; gelingt das nicht, wird die Position sofort wieder
  geschlossen. Beendest du den Bot mit Strg+C, bleiben Positionen so durch ihre Börsen-Stops geschützt.

## LLM-Strategie-Recherche (optional)
`llm.enabled: true` und `ANTHROPIC_API_KEY` setzen. Das LLM liefert nur JSON-Spezifikationen (Typ + feste Parameter +
Marktphasen), die gegen die erlaubten Typen und Parametergrenzen validiert werden. **Es wird nie generierter Code
ausgeführt.** Vorschläge sind nur Kandidaten – live geschaltet wird ausschließlich, was der Backtester zulässt.
Neue Strategietypen fügst du als Klasse in `strategies.py` hinzu.

## Live-Betrieb (erst nach ausgiebigem Paper-Test)
1. API-Key bei der Börse anlegen: **nur Handel, keine Auszahlungsrechte**, nach Möglichkeit IP-Beschränkung.
2. Keys als Umgebungsvariablen setzen (siehe `.env.example`), nicht in Dateien schreiben.
3. In `config.yaml`: `live_trading: true` und `capital.start` auf den Betrag, den der Bot maximal einsetzen darf.
4. Mit einem sehr kleinen Betrag beginnen und die ersten Orders (inkl. Stop-Order) an der Börse kontrollieren.

## Hinweise
- **Kraken-Historie**: Die Kraken-API liefert nur die letzten 720 Kerzen. Deshalb lädt `market.history_exchange`
  (Standard `bitstamp`, gleiche Symbole) die tiefere Historie für Backtests; fällt sie aus, wird Kraken genutzt, und bei
  weniger als `backtest.min_candles` gibt es keine Zulassung. Preise verschiedener Börsen weichen leicht ab.
- Die Mindestwerte in `backtest:` sind Startwerte. Mit ca. 31 Tagen Historie (3000 × 15m) ist die Aussagekraft begrenzt;
  mehr Historie und strengere Werte machen die Zulassung robuster. Wenn nichts zugelassen wird, handelt der Bot nicht.
- Die Live-Order-Logik (insbesondere die Stop-Order über ccxt `stopLossPrice`) ist gegen eine Test-Börse geprüft, nicht
  gegen eine echte – teste sie mit kleinem Betrag, bevor du ihr vertraust.

## Dauerbetrieb im Hintergrund (`deploy/`)
Der Bot lädt API-Keys automatisch aus `.env` (Vorlage: `.env.example`, nicht einchecken).
- **Linux:** `deploy/tradingbot.service` (systemd-User-Dienst, niedrige Priorität, Neustart nach Absturz)
- **macOS:** `deploy/com.tradingbot.plist` (launchd)
- **Windows:** `deploy/install_windows.ps1` (Aufgabenplanung, unsichtbar, niedrige Priorität)

Der Rechner muss durchlaufen (kein Standby), sonst pausiert der Bot; Positionen bleiben durch ihre Börsen-Stops
geschützt. Für echten 24/7-Betrieb ist ein kleiner VPS zuverlässiger. Die Not-Aus-Datei `KILL_SWITCH` wirkt auch hier.

## Phantom / Solana (`broker: solana`)
Phantom ist eine Wallet, kein Broker, und lässt sich nicht fernsteuern. Der Bot handelt deshalb **SOL ↔ USDC über den
Jupiter-Aggregator** mit einer **eigenen Bot-Wallet**, die er selbst signiert. Phantom nutzt du nur zum Ansehen/Befüllen.
Signale kommen weiter aus Börsendaten (SOL/USD), nur die Ausführung läuft auf Solana. Konfiguration: `config.solana.yaml`.

1. In Phantom ein **neues Konto nur für den Bot** anlegen (nicht die Haupt-Wallet!) und dessen privaten Schlüssel
   exportieren → `SOLANA_PRIVATE_KEY` in `.env`. Der Schlüssel liegt damit im Klartext auf dem Rechner: nur Geld in die
   Wallet legen, dessen Totalverlust du verkraftest.
2. Wallet befüllen: **USDC** (Handelskapital) und ca. **0,1 SOL** (Gebühren; `sol_reserve` wird nie verkauft).
3. Paper-Test: `python main.py --config config.solana.yaml research` und `... run` (läuft ohne Schlüssel).
4. Live: in `config.solana.yaml` `live_trading: true`, `capital.start` = max. USDC, dann `... run`. Beim Start steht die
   Wallet-Adresse mit Salden in der Ausgabe – mit Phantom abgleichen. Mit sehr kleinem Betrag anfangen.

**Unterschiede zur Börse – bitte ernst nehmen:**
- **Kein Stop an der Gegenseite.** Der Stop-Loss wird vom Bot im `poll_seconds`-Takt geprüft und dann per Swap verkauft.
  Fällt Rechner/Internet/Bot aus, ist die Position **ungeschützt**. Der Bot muss also zuverlässig laufen (am besten VPS).
- Kurs-Lücken, Slippage und MEV können Stops schlechter ausführen als berechnet. Schutz: `slippage_bps`,
  `max_deviation_pct` (Abbruch bei > 1 % Abweichung vom Marktpreis) und `max_price_impact_pct`.
- Nur SOL (liquide Majors). Memecoins/kleine Tokens sind bewusst nicht unterstützt (Rug Pulls, Honeypots, keine Historie).
- Der öffentliche Solana-RPC ist rate-limitiert; für Dauerbetrieb einen eigenen RPC-Anbieter eintragen.
- Ein Swap kann bestätigt werden, nachdem der Bot das Zeitlimit meldet. Bei der Meldung „Status unklar“ die Wallet prüfen.
- Jupiters API-URL/Konditionen können sich ändern (`jupiter_url` in der Config) – gegen die aktuelle Doku prüfen.

### Neue Bot-Wallet erzeugen (empfohlen – kein Export aus Phantom nötig)
`python main.py new-wallet --show-key` erzeugt ein frisches Schlüsselpaar, legt es im Schlüsselbund ab und zeigt die öffentliche
Adresse (und einmalig den Schlüssel als Offline-Backup). Dann USDC und ca. 0,1 SOL aus Phantom an diese Adresse senden.

### Schlüssel sicher ablegen (statt `.env`)
`python main.py set-key` fragt den privaten Schlüssel der Bot-Wallet unsichtbar ab und speichert ihn im
Betriebssystem-Schlüsselbund (macOS Keychain, Windows Credential Manager, Linux Secret Service). Der Bot nutzt ihn
automatisch; eine Umgebungsvariable hat Vorrang. In Phantom: Konto-Menü → Settings → Manage Accounts → Bot-Konto →
Show Private Key (nie die Recovery-Phrase und nie das Hauptkonto). Auf einem Linux-Server ohne Desktop gibt es evtl.
keinen Schlüsselbund – dann `.env` mit Dateirechten `chmod 600` nutzen.

## Browser-Extension
Der Bot existiert zusätzlich als Chrome-Extension (Ordner `extension/`, SOL/BTC/ETH gegen USDC über Jupiter, Paper-Modus Standard).
Installation und ausdrückliche Einschränkungen (Browser muss laufen, Wallet nach Neustart entsperren, Stop nur bot-seitig):
siehe `extension/README.md`.
