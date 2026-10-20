# Trading-Bot als Desktop-App (Electron)

Die Browser-Erweiterung aus `../extension` als eigenständiges Programm – **ohne Chrome**, mit derselben Logik und Oberfläche
(Status, Strategien, Trades, Wallet, Dashboard, Einstellungen, Telegram). Die Erweiterung wird unverändert geladen; `chrome-shim.js` stellt die
wenigen `chrome.*`-Funktionen bereit (Speicher in einer JSON-Datei, Hintergrunddienst als unsichtbares Fenster, Timer statt Alarme,
Windows-Benachrichtigungen). Paper-Modus bleibt Standard.

## Drei Bots, ein Konto
Die App hat **drei Tabs** – jeder ist ein eigener Bot mit eigenen Märkten, Strategien, Positionen und Einstellungen:

| Tab | Märkte | Kursdaten | Standard-Zeitrahmen |
|---|---|---|---|
| **Währungen** | EUR/USD, GBP/USD, AUD/USD, NZD/USD, USD/EUR | Yahoo Finance | 1 Stunde |
| **Silber & Gold** | XAU/USD (Gold), XAG/USD (Silber), XPT/USD (Platin) – Futures | Yahoo Finance | 1 Stunde |
| **Krypto** | SOL, BTC, ETH, JUP … (wie in der Erweiterung) | Kraken/Bitstamp/Coinbase | 15 Minuten |

Alle drei teilen sich **ein Paper-Konto** (Spielgeld, Standard 300 USD): ein gemeinsames Bargeld, Eigenkapital = Bargeld + Wert aller Positionen aller Bots
(Kopfzeile). Tageslimit und Positionsgröße rechnen mit diesem gemeinsamen Eigenkapital. „NOT-AUS (alle)“ schließt die Positionen aller Bots.
Telegram (`/status`, `/stop`, `/kill ja`) gilt für alle drei. Telegram-/LLM-Zugang und Startkapital sind für alle gleich, alles andere je Bot
(⚙ Einstellungen im jeweiligen Tab; „Paper-Konto zurücksetzen“ dort setzt das gemeinsame Konto zurück).

Grenzen: Währungen und Metalle laufen **nur im Paper-Modus** (Live gibt es nur für Krypto über die Solana-Wallet; für echte Währungen/Metalle
gibt es die MetaTrader-App in `../mt5bot`). Nur Kauf (Long), **ohne Hebel**: bei Währungen sind die Stops eng, deshalb deckelt die maximale
Positionsgröße (33 % des Kapitals) das Risiko meist weit unter 1 % – Gewinne und Verluste bleiben klein. USD/EUR ist der Kehrwert von EUR/USD und
rechnet das Spielgeld 1:1 (Näherung). Yahoo-Daten: Innertageskerzen reichen nur ~60 Tage (5/15/30 Min.) bzw. ~2 Jahre (1 Std.) zurück.

## Gebühren (bewusst zu hoch)
Backtest und Paper-Handel rechnen bei **jedem Kauf und jedem Verkauf** Gebühr/Spread plus Rutschen ab. Untergrenzen je Order:
Krypto 0,26 % + 0,20 %, Währungen 0,03 % + 0,03 %, Metalle 0,06 % + 0,06 % – deutlich mehr als echte Broker verlangen. Niedriger eingestellte Werte
werden automatisch auf diese Grenze angehoben, höhere bleiben. Der PnL in Meldungen ist **netto nach Gebühren**.

## Discord-Meldungen
Einstellungen (⚙ in irgendeinem Tab) → *Discord-Meldungen*: Webhook-URL einfügen, *Aktiv* anhaken, speichern, *Discord testen*. Gilt für alle drei Bots. Es kommen:
- **Kauf** sofort: Menge, Preis, Wert, Gebühr, **Stop-Loss, Take-Profit**, Risiko, Strategie, Marktphase und **„Warum gekauft“** (Signal, Marktphase, Backtest-Werte).
- **Verkauf** sofort: Preis, Einstieg, **PnL netto nach Gebühren**, Stop/Ziel, Haltedauer und **„Warum verkauft“** (Stop, Ziel oder Ausstiegssignal).
- **Stundenbericht** je Bot (beim Start und danach jede Stunde): Eigenkapital, Käufe/Verkäufe seit dem letzten Bericht, je Markt **warum nicht gekauft**
  (keine zugelassene Strategie, Marktphase passt nicht, kein Signal, Position schon offen, Tageslimit, Positionslimit …) und offene Positionen mit aktuellem Ergebnis.
- Warnungen (Not-Aus, Tageslimit, Fehler).
Die Webhook-URL gehört nicht ins Repository und nicht in Chats: wer sie kennt, kann in deinen Kanal schreiben. Bei Verdacht in Discord löschen und neu anlegen.

## Starten (mit Node.js ≥ 20)
```
cd desktop
npm install
npm start
```
Fenster schließen = Bot läuft im Hintergrund weiter (Symbol im Infobereich der Taskleiste; dort „Beenden“ und „Autostart“).
Daten liegen unter `%APPDATA%\Trading-Bot\storage.json`.

## Fertige Windows-App
GitHub → *Actions* → „Desktop-App bauen“ → *Run workflow* → Artefakt `TradingBot-Desktop` herunterladen
(Installer oder portable `.exe`). Selbst bauen: `npm run dist` (Ergebnis in `desktop/dist`).
SmartScreen warnt bei unsignierten Programmen: *Weitere Informationen → Trotzdem ausführen*.

## Unterschiede zu Chrome
- Kein Browser-Sandbox-Schutz der Erweiterungs-Berechtigungen: die App darf Börsen-/Telegram-/Solana-Server direkt ansprechen (`webSecurity` aus),
  lädt aber ausschließlich den eigenen Code; Links gehen in den Standardbrowser.
- Wallet-Entsperrung (Live) liegt nur im Speicher und ist nach dem Beenden der App weg – wie beim Schließen von Chrome.
- Läuft nur, solange die App läuft (Tray-Symbol). Für 24/7: Autostart einschalten und Windows nicht in den Ruhezustand schicken.
- **Geprüft:** Start unter Linux/Xvfb, Popup, Hintergrunddienst, Speicher, Dashboard/Einstellungen-Fenster, Nachrichtenweg, Umgehen der CORS-Sperre. 
  **Nicht geprüft:** Windows-Build, Tray/Autostart unter Windows, echte Börsen- und Yahoo-Verbindungen (in der Entwicklungsumgebung gesperrt – ob Yahoo die Anfragen der App annimmt, zeigt sich erst bei dir).
- Die Chrome-Erweiterung selbst bleibt ein einzelner (Krypto-)Bot; die drei Tabs gibt es nur in der Desktop-App. Die MetaTrader-Variante ist die Python-App in `../mt5bot` (siehe `mt5bot/APP.md`).
