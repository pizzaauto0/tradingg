# MT5-Bot als App

Die App macht dasselbe wie die Browser-Erweiterung (Strategien suchen, prüfen, freigeben, handeln, erklären, Einstellungen, Telegram) – nur
dass **MetaTrader 5** die Kurse liefert und die Orders ausführt (Demo-Konto). Alles Einstellbare steht im Programm; `config.py` musst du nicht anfassen.

## Funktionen 1:1 zur Erweiterung

| Erweiterung | App (Portal) |
|---|---|
| Strategien suchen/backtesten (Profile strict / explore / playbook / winrate / final) | Reiter **Strategien**: Modus wählen → *Prüfung starten* (Kerzen kommen aus MetaTrader, mit Gebühren/Slippage, Out-of-Sample-Teil) |
| Nur zugelassene Strategien handeln | Profil **auto**: die besten N (Einstellungen) je Markt handeln, jede mit eigener Magic Number (100301–100309) |
| „Warum (nicht)?“ | Spalte *Warum (nicht)?* in den Ergebnissen + Reiter Übersicht / Telegram `/diagnose` |
| Trotzdem freigeben | Knopf *Trotzdem aktivieren* (mit Rückfrage) |
| Einstellungsseite | Reiter **Einstellungen** (Risiko, Limits, Märkte je Profil, Intervalle, Pfad zu MetaTrader …) |
| Telegram | Einstellungen → *Telegram*: Token einfügen, dem Bot /start schicken, bestätigen. Befehle `/strategien`, `/pruefen [Modus]` |
| Testtrade, Dashboard, Aktivität | Übersicht: Klick-Steuerung, Positionen, Statistik, Märkte & Signale |
| Immer an, auch nach Neustart | Einstellungen → *Windows-Start* |

Sicherheit bleibt wie beim Bot: nur Demo-Konten (Echtgeld nur, wenn du es in `config.py` von Hand erlaubst), höchstens 2 % Risiko je Trade,
Stop-Loss und Ziel an jeder Order, Tagesverlust-Limit, Positionslimit, Kill-Switch. Einstellungen sind nur am PC selbst änderbar, nicht vom Handy.

## Installieren

**A) Fertige Windows-App (ohne Python):** Auf GitHub unter *Actions → „Windows-App bauen“ → Run workflow* die Datei `MT5Bot-Windows` herunterladen,
entpacken, `MT5Bot.exe` starten (Ordner komplett behalten). Alternativ selbst bauen: `packaging\build_exe.bat`.
Beim ersten Start ggf. Windows-SmartScreen: *Weitere Informationen → Trotzdem ausführen* (die App ist nicht signiert).

**B) Mit Python:** `mt5bot\setup_laptop.bat` (einmalig), danach `mt5bot\start_app.bat` oder `python -m mt5bot.app`.
Desktop-Verknüpfung: `python -m mt5bot.app --shortcut`.

Vorher: MetaTrader 5 installieren, in ein **Demo-Konto** einloggen, oben **Algo-Handel** einschalten (grün). Die App startet MetaTrader selbst,
wenn es unter `C:\Program Files\MetaTrader 5` liegt.

Daten (Einstellungen, Protokolle, Journal, Telegram-Zugang) liegen in `%APPDATA%\MT5Bot`.

## Erste Schritte
1. App starten → Fenster öffnet sich. Oben rechts muss „Broker live“ stehen.
2. **Einstellungen**: Profil `auto` einschalten (Märkte prüfen: Symbolnamen wie beim Broker, z. B. `XAUUSD:D1`) → *Speichern*.
3. **Strategien**: Modus *strict* → *Prüfung starten* (einige Minuten). Zugelassene Strategien erscheinen unter *Aktiv* und handeln ab der nächsten Kerze.
   Ist nichts zugelassen, steht in der Tabelle, woran es liegt. *explore* ist lockerer (nur Demo!).
4. Telegram einrichten (optional), Autostart einschalten (optional).
5. Mindestens 4 Wochen Demo beobachten, bevor irgendetwas anderes in Frage kommt (siehe `STRATEGIE_CHECKLISTE.md`).

## Auf dem Handy als App
Im Portal-Link (Handy-Link steht in der Übersicht am PC; im WLAN oder per Tailscale) im Browser *Zum Startbildschirm hinzufügen* – das Portal öffnet dann
wie eine App (Symbol, ohne Adressleiste). Dort Ansehen und Klick-Steuerung nach Einstellung; Einstellungen ändern geht nur am PC.

## Grenzen (ehrlich)
- Ein Backtest auf Broker-Kerzen ist keine Garantie; Ergebnisse hängen von der Historie ab, die der Broker liefert (Einstellung *Kerzen je Markt*).
- Die Windows-App wird auf GitHub gebaut und konnte hier nicht auf einem echten Windows-PC mit MetaTrader getestet werden; Logik, Portal und Prüfung sind mit Attrappen getestet.
- Telegram-Änderungen (an/aus) greifen nach „Telegram neu verbinden“ bzw. App-Neustart.
