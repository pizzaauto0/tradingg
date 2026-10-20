# Trading-Bot als Desktop-App (Electron)

Die Browser-Erweiterung aus `../extension` als eigenständiges Programm – **ohne Chrome**, mit derselben Logik und Oberfläche
(Status, Strategien, Trades, Wallet, Dashboard, Einstellungen, Telegram). Die Erweiterung wird unverändert geladen; `chrome-shim.js` stellt die
wenigen `chrome.*`-Funktionen bereit (Speicher in einer JSON-Datei, Hintergrunddienst als unsichtbares Fenster, Timer statt Alarme,
Windows-Benachrichtigungen). Paper-Modus bleibt Standard.

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
  **Nicht geprüft:** Windows-Build, Tray/Autostart unter Windows, echte Börsenverbindungen (in der Entwicklungsumgebung gesperrt).
- Dies ist die Krypto-/Solana-Erweiterung (Paper). Die MetaTrader-Variante ist die Python-App in `../mt5bot` (siehe `mt5bot/APP.md`).
