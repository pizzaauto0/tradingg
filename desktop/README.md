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

## Dashboard: kaufen, verkaufen, Stop-Loss/Take-Profit verschieben
Im Dashboard (📈 im jeweiligen Tab) steht neben dem Chart die Karte **Handeln**:
- **Kaufen** (nur Paper): Betrag in USD, Stop-Loss und Take-Profit optional (leer = Betrag nach Risikoregel, Stop 2×ATR, Ziel nach Regel). Gebühren sind eingerechnet; harte Grenzen: höchstens 2 % Risiko, maximale Positionsgröße, Positionslimit.
- **Verkaufen**: schließt die Position sofort zum Marktpreis. **Stop-Loss/Take-Profit setzen**: beliebiger Kurs (Stop muss unter, Ziel über dem Kurs liegen); Schnellknöpfe „Stop → Einstand“, „Stop sichert 50 % / 75 %“.
- Darunter der Verlauf aller Anpassungen (wer: Du oder KI, von → nach, Grund) und die Liste der Käufe und Verkäufe des Marktes.

### KI-Trailing
Der Bot zieht den Stop-Loss selbst nach, sobald eine Position im Plus ist – **regelbasiert und mit Begründung, kein Sprachmodell**. Beispiel: ab **+40 USD** Gewinn (oder ab 1× dem ursprünglichen Risiko, es genügt eine Bedingung) liegt der Stop bei **+30** (75 % gesichert).
Je nach Lage: starker Aufwärtstrend (ADX ≥ 25) → weniger sichern (der Trend darf laufen) und bei Kurs nahe am Ziel das Ziel um 1R anheben (höchstens 3×); Seitwärts/Abwärts → mehr sichern.
Sicherungen: Stop nur nach oben, nie unter Einstand + Kosten (er liegt wirklich im Plus), nie näher als 0,5 ATR am Kurs. Jede Anpassung kommt als Meldung (Discord: 🔒) und steht im Trade-Log. Einstellbar unter ⚙ „KI-Trailing“, je Position im Dashboard abschaltbar.
Hinweis: Das Spielgeld rechnet in USD (kein Euro). Bei kleinem Konto greift meist die 1R-Bedingung früher als die 40 USD.

## Discord-Knöpfe: Live-Statistik vom Handy
Ein Knopf unter einer Nachricht kann nur von einem **Discord-Bot** beantwortet werden (ein Webhook allein kann das nicht). Einmal einrichten:
1. discord.com/developers/applications → *New Application* → links *Bot* → *Reset Token* → Token kopieren (nie weitergeben).
2. *OAuth2 → URL Generator*: Haken bei `bot`, Rechte *Nachrichten senden* und *Links einbetten* → erzeugte URL öffnen, Bot auf deinen Server einladen.
3. In Discord *Einstellungen → Erweitert → Entwicklermodus* an; den Kanal rechtsklicken → *Kanal-ID kopieren*.
4. In der App ⚙ Einstellungen → *Discord-Meldungen*: *Aktiv*, Bot-Token und Kanal-ID eintragen, speichern, **„Discord-Knöpfe posten“**.

Im Kanal erscheint eine Nachricht mit drei Knöpfen: **📊 Live-Statistik** (Konto, Bilanz netto nach Gebühren, offene Trades mit Stop-Loss/Take-Profit und aktuellem Ergebnis, letzte Käufe/Verkäufe),
**📌 Offene Trades**, **🧾 Käufe & Verkäufe**. Die Antwort sieht nur, wer geklickt hat; „🔄 Aktualisieren“ lädt sie neu. Der Klick geht von **jedem Gerät und jedem Netz** (Handy, Mobilfunk, anderes WLAN),
weil sich die App auf dem PC *ausgehend* mit Discord verbindet – es muss nichts freigegeben werden. Voraussetzung: die App läuft auf dem PC (Tray-Symbol) und der PC hat Internet.
Die Knöpfe zeigen nur an, sie können nichts kaufen oder verkaufen und antworten nur im eingerichteten Kanal. Optional: *Live-Nachricht im Kanal* – eine Webhook-Nachricht, die sich jede Minute selbst aktualisiert (anpinnen).

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
