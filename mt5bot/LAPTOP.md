# MT5-Bot auf dem Laptop einrichten (Windows)

Voraussetzung: Windows 10/11, **64-Bit**. Das Paket `MetaTrader5` gibt es nur für Windows.

## 1. Programme installieren
1. **Python** von https://www.python.org/downloads/ (3.11 oder neuer, 64-Bit). Beim Installieren unten **„Add python.exe to PATH"** ankreuzen.
2. **Git** von https://git-scm.com/download/win (alles auf Standard lassen) – oder statt Git das Projekt als ZIP laden (Schritt 2).
3. **MetaTrader 5** von der Webseite deines Brokers installieren und ein **Demo-Konto** einloggen (Datei → Konto eröffnen/Anmelden).
   In MetaTrader oben auf **„Algo-Handel"** klicken (grün) und unter Extras → Optionen → Experten „Algo-Handel erlauben" aktivieren.

## 2. Den Bot holen
Terminal öffnen (Windows-Taste, „cmd" tippen) und:
```
cd %USERPROFILE%\Documents
git clone -b claude/great-bell-6lgr1f https://github.com/pizzaauto0/tradingg.git
cd tradingg
```
Ohne Git: https://github.com/pizzaauto0/tradingg/tree/claude/great-bell-6lgr1f → Code → Download ZIP, entpacken, im Ordner ein Terminal öffnen.

## 3. Einrichten
Doppelklick auf **`mt5bot\setup_laptop.bat`** (oder im Terminal `mt5bot\setup_laptop.bat`). Es prüft Python, installiert die Pakete und macht einen Selbsttest.

## 4. Konfiguration prüfen (`mt5bot\config.py`, mit dem Editor öffnen)
- `ALLOW_REAL_ACCOUNT = False` lassen (nur Demo).
- `MT5_TERMINAL_PATH`: Pfad zur `terminal64.exe` eintragen, z. B. `r"C:\Program Files\MetaTrader 5\terminal64.exe"` – dann startet der Bot MetaTrader selbst.
- Symbole: Heißt Gold bei deinem Broker `GOLD`, `XAUUSD.a` o. ä.? Der Bot probiert die Namen aus `SYMBOL_ALIASES`. Im Log steht „XAUUSD: aktiv als …" oder eine Warnung.
- Profile: `video` ist an, die anderen aus.

## 5. Telegram (optional, empfohlen)
`python -m mt5bot.telegram_setup` – Anleitung erscheint im Fenster (Bot bei @BotFather anlegen, Token eingeben, dem Bot schreiben).

## 6. Starten
```
python -m mt5bot.run
```
Das Portal öffnet sich im Browser (http://127.0.0.1:8765). Im Terminal siehst du „Verbunden: Konto … DEMO". Stoppen: Strg+C.

## 7. Dauerbetrieb auf dem Laptop
- `python -m mt5bot.autostart install`: startet den Bot beim Anmelden und nach Abstürzen neu. Windows muss sich nach einem Neustart automatisch anmelden (sonst startet nichts).
- **Ruhezustand ausschalten:** Einstellungen → System → Netzbetrieb & Akku → „Bildschirm und Energiesparmodus": bei **Netzbetrieb** „Nie" für den Energiesparmodus.
- **Deckel zu:** Einstellungen → System → Netzbetrieb → „Weitere Energieeinstellungen" → „Auswählen, was beim Zuklappen des Computers geschehen soll" → bei Netzbetrieb **„Nichts unternehmen"**.
- Laptop **am Netzteil** lassen. WLAN darf nicht abschalten (Gerätemanager → Netzwerkadapter → WLAN → Energieverwaltung: „Computer darf Gerät ausschalten" abwählen).
- Windows-Updates erzwingen Neustarts: Aktive Zeiten einstellen. Der Autostart startet den Bot danach wieder.
- Für wirklich unterbrechungsfreien Betrieb ist ein Windows-VPS besser.

## 8. Kontrolle
- Portal: http://127.0.0.1:8765, auf dem Handy: Link aus dem Kasten oben auf der Seite (siehe README).
- Dateien: `logs\bericht_<Datum>.txt` (stündlich), `logs\entscheidungen_<Datum>.log`, `mt5bot.log`, `mt5bot_trades.csv`.
- Telegram: Taste „📊 Status".

## Von einem anderen PC mitnehmen (optional)
Kopiere `mt5bot_telegram.json` (Telegram bleibt eingerichtet) und – falls der Bot dasselbe Konto weiterführen soll – `mt5bot_state.json`, `mt5bot_trades.csv`, `mt5bot_equity.csv`.
**Starte den Bot nie gleichzeitig auf zwei Rechnern mit demselben Konto und denselben Profilen** (doppelte Trades). Auf dem alten PC vorher beenden (Strg+C).

## Update später
```
cd %USERPROFILE%\Documents\tradingg
git pull origin claude/great-bell-6lgr1f
```
Dann den Bot neu starten.
