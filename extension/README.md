# Trading-Bot als Browser-Extension (Chrome/Edge/Brave, Manifest V3)

Der komplette Bot läuft als Erweiterung im Browser: Marktanalyse, Strategie-Recherche (optional per LLM), Backtest mit
Gebühren und Slippage, Strategie-Auswahl je Marktphase, Risikomanagement, Not-Aus und Trade-Log mit Begründung.
Gehandelt wird **SOL ↔ USDC auf Solana über Jupiter** mit einer eigenen Bot-Wallet. **Paper-Modus ist Standard.**
Die Logik ist ein 1:1-Port des Python-Bots (Kennzahlen stimmen in den Tests auf 6 Nachkommastellen überein).

> **Keine Anlageberatung, keine Gewinngarantie.** Nur Geld einsetzen, dessen Totalverlust du verkraftest.

## Installation
1. Chrome öffnen → `chrome://extensions` → oben rechts **Entwicklermodus** einschalten.
2. **Entpackte Erweiterung laden** → den Ordner `extension/` dieses Projekts wählen.
3. Das Extension-Symbol anklicken (am besten anheften). Das Popup zeigt Status, Strategien, Trades und Wallet.

## Paper-Modus (Standard, kein Geld, keine Wallet nötig)
1. Popup → **Bot starten**. Beim ersten Start werden Historie geladen, alle Kandidaten gebacktestet und nur Strategien
   über den Mindestwerten zugelassen (Tab „Strategien“). Danach läuft alle 30 Sekunden ein Durchlauf.
2. Einstellungen (Rechtsklick auf das Symbol → Optionen): Kapital, Risiko, Tageslimit, Mindestwerte, optional LLM/Telegram.
3. **NOT-AUS** schließt die Position sofort und stoppt den Bot.

## Live-Modus (erst nach mehrwöchigem Paper-Test)
1. Tab **Wallet** → Passwort wählen → **Neue Wallet erzeugen**. Den angezeigten Backup-Schlüssel **offline sichern**
   (Papier). Ohne Backup ist das Guthaben bei Verlust des Browserprofils weg. Alternativ einen vorhandenen Schlüssel
   importieren (nicht die Recovery-Phrase, nicht dein Hauptkonto).
2. Die Adresse mit **USDC** und ca. **0,1 SOL** (Gebühren) befüllen, z. B. aus Phantom. Sehr kleine Beträge zuerst.
3. Optionen → **LIVE-Modus** einschalten (Bestätigung durch Eintippen von LIVE), `Kapital` = max. einzusetzendes USDC.
4. Popup → Wallet **entsperren** → **Bot starten**.

## Was du wissen musst (ehrlich)
- **Der Browser muss laufen.** Die Extension handelt nur, solange Chrome läuft und der Rechner nicht schläft. Chrome kann
  im Hintergrund weiterlaufen (Einstellung „Hintergrund-Apps weiter ausführen“), ist aber kein Server. Für echten
  24/7-Betrieb ist der Python-Bot auf einem VPS zuverlässiger.
- **Nach jedem Browser-Neustart muss die Wallet entsperrt werden** (Passwort). Der entschlüsselte Schlüssel liegt nur im
  Arbeitsspeicher (`storage.session`). Solange die Wallet gesperrt ist, kann der Bot weder handeln noch einen Stop auslösen;
  das Symbol zeigt dann „LOCK“ und es kommt eine Benachrichtigung.
- **Der Stop-Loss ist nur bot-seitig** (kein Stop bei einer Börse) und wird alle 30 Sekunden geprüft – gröber als beim
  Python-Bot (10 s). Bei Ausfall von Browser/Internet ist eine Position ungeschützt. Schnelle Kurssprünge können
  schlechter ausgeführt werden als berechnet. Schutz: Slippage-Limit, Abbruch bei > 1 % Preisabweichung, Preisauswirkung.
- **Unklarer Orderstatus:** Wird der Browser mitten in einem Swap beendet, stoppt der Bot beim nächsten Durchlauf mit der
  Meldung „Unklarer Orderstatus“. Dann Wallet prüfen und im Popup bestätigen.
- **Schlüssel im Browser:** verschlüsselt (AES-256-GCM, PBKDF2 600.000 Iterationen) im Extension-Speicher. Das ist weniger
  isoliert als der Betriebssystem-Schlüsselbund des Python-Bots; ein kompromittiertes Browserprofil mit bekanntem
  Passwort gibt den Schlüssel frei. LLM- und Telegram-Schlüssel liegen unverschlüsselt im Extension-Speicher.
- **Nicht gegen echte Dienste getestet.** Kraken-, Bitstamp-, Jupiter- und Solana-RPC-Aufrufe sind nur gegen Attrappen
  geprüft (die Entwicklungsumgebung hatte kein Internet). Das Signieren ist dagegen Byte für Byte gegen `solders`
  verifiziert. Teste Live zuerst mit wenigen Dollar und kontrolliere die erste Transaktion in einem Solana-Explorer.
- Der öffentliche Solana-RPC ist rate-limitiert; trag in den Optionen einen eigenen RPC-Anbieter ein (die Extension fragt
  dann die Berechtigung für diesen Host an). Jupiters API-URL und Konditionen können sich ändern.
- Historie: Bitstamp (Fallback Kraken mit nur 720 Kerzen → dann keine Zulassung, da Mindestmenge 1000).

## Entwicklung / Tests
```bash
node --test extension/test/*.test.mjs                       # 16 Tests (Node 20+)
python extension/test/make_parity_fixture.py                # Python-Referenzwerte neu erzeugen
python extension/test/make_sign_fixture.py                  # Signatur-Referenz (solders) neu erzeugen
```
Aufbau: `background.js` (Alarm alle 30 s, Nachrichten), `popup.*`/`options.*` (Oberfläche), `lib/` mit `indicators`,
`strategies`, `backtest`, `risk`, `engine`, `pipeline`, `research`, `data`, `solana` (Jupiter/Signatur/Paper-Broker),
`vault` (Verschlüsselung), `controller`, `nacl.js` (tweetnacl 1.0.3, gemeinfrei, als ES-Modul verpackt).
