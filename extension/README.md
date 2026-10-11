# Trading-Bot als Browser-Extension (Chrome/Edge/Brave, Manifest V3)

Der komplette Bot läuft als Erweiterung im Browser: Marktanalyse, 25 Strategietypen in 33 Varianten (siehe
[STRATEGIEN.md](../STRATEGIEN.md)), Strategie-Recherche (optional per LLM), Backtest mit
Gebühren und Slippage, Strategie-Auswahl je Marktphase, Risikomanagement, Not-Aus und Trade-Log mit Begründung.
Gehandelt werden **mehrere Märkte gleichzeitig: SOL, BTC und ETH gegen USDC auf Solana über Jupiter** (einzeln in den
Optionen abschaltbar) mit einer eigenen Bot-Wallet. **Paper-Modus ist Standard.**
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
3. Im Popup zeigt die Karte **Aktivität**, dass der Bot arbeitet: grün pulsierender Punkt, „Letzte Prüfung vor X s“,
   aktueller Kurs, Marktphase, gewählte Strategie, Einstiegssignal, Countdown bis zur nächsten Kerzenprüfung und ein
   Protokoll jeder geprüften Kerze. Das Symbol zeigt „ON“. „Jetzt prüfen“ löst sofort einen Durchlauf aus.
4. **NOT-AUS** schließt die Position sofort und stoppt den Bot.

## Live-Modus (erst nach mehrwöchigem Paper-Test)
1. Tab **Wallet** → Passwort wählen → **Neue Wallet erzeugen**. Den angezeigten Backup-Schlüssel **offline sichern**
   (Papier). Ohne Backup ist das Guthaben bei Verlust des Browserprofils weg. Alternativ einen vorhandenen Schlüssel
   importieren (nicht die Recovery-Phrase, nicht dein Hauptkonto).
2. Die Adresse mit **USDC** und ca. **0,1 SOL** (Gebühren) befüllen, z. B. aus Phantom. Sehr kleine Beträge zuerst.
3. Optionen → **LIVE-Modus** einschalten (Bestätigung durch Eintippen von LIVE), `Kapital` = max. einzusetzendes USDC.
4. Popup → Wallet **entsperren** → **Bot starten**.

## Strategien: 55 % Trefferquote, 5 aktiv
Jede der 33 Varianten wird je Markt gebacktestet. Zugelassen wird nur, was u. a. **mindestens 55 % Trefferquote** und
zugleich Gewinn, Sharpe ≥ 1 und Profit Factor ≥ 1,2 erreicht. Davon handeln die **5 besten aktiv** (★ im Tab
„Strategien“), der Rest ist Reserve (✔). Beides ist in den Optionen einstellbar. Hohe Trefferquoten allein machen
keinen Gewinn – mehr dazu und ein Ergebnis auf echten Daten in [STRATEGIEN.md](../STRATEGIEN.md).
Forex gibt es nur im Python-Bot (Interactive Brokers), nicht in der Extension.

## Playbook: 5 feste Strategien (nur Paper)

Basierend auf der Strategie-Übersicht von trading.de (Trendkanal, Swing/Pullback, Price Action, Unterstützung/Widerstand, Mean Reversion). Im Strategien-Tab unter „Warum (nicht)?" auf **„Playbook: 5 feste Strategien (nur Paper)"** klicken. Alle 5 sind dann aktiv, ohne Backtest-Freigabe; der Bot wählt je Markt und Marktphase die mit dem besten Sharpe. Abwärtstrend = keine Position (nur Long). Nicht bewiesen profitabel, nur im Paper-Modus erlaubt.

| Strategie | Typ |
|---|---|
| Trendkanal-Ausbruch | `breakout` 55/20 |
| Pullback im Trend (Swing) | `trend_pullback` |
| Price Action: Inside Bar | `inside_bar` |
| Range: Unterstützung kaufen | `range_support` |
| Mean Reversion: Bollinger | `bollinger_reversion` |

## Auf dem Handy: Steuerung per Telegram
Die Extension läuft nur in einem Desktop-Browser (Chrome, Brave, Edge). Auf dem Handy bedienst du den Bot **per Telegram**:

1. In Telegram **@BotFather** öffnen → `/newbot` → Namen vergeben → den **Token** kopieren.
2. Deinem neuen Bot eine Nachricht schreiben (z. B. „hallo“). Dann **@userinfobot** anschreiben: Er nennt deine **Chat-ID** (Zahl).
3. Im Popup **⚙ Einstellungen** → „Telegram“: Aktiv anhaken, Token und Chat-ID eintragen, speichern.
4. Ab jetzt meldet der Bot jeden Einstieg/Ausstieg und jede Warnung aufs Handy, und du kannst ihm schreiben:

| Befehl | Wirkung |
|---|---|
| `/status` | Zustand, offene Positionen mit Gewinn/Verlust, Märkte, aktive Strategien |
| `/stop` | Handel stoppen (offene Positionen bleiben mit ihren Stops) |
| `/kill ja` | NOT-AUS: alle Positionen schließen und stoppen (ohne „ja“ fragt der Bot nach) |
| `/help` | Befehlsliste |

- **Sicherheit:** Befehle werden nur aus deinem eigenen Chat (deiner Chat-ID) ausgeführt, Nachrichten anderer Chats werden
  ignoriert. Es gibt bewusst **kein „Starten“ und keine Einstellungen** per Telegram – nur Befehle, die das Risiko senken.
  Nachrichten, die älter als 2 Minuten sind, und alles, was schon vor der ersten Abfrage bereitlag, wird nicht ausgeführt.
- **Wichtig:** Der Browser auf dem PC muss laufen. Der Bot fragt Telegram alle 30 Sekunden ab, ein Befehl wirkt also mit bis
  zu 30 Sekunden Verzögerung. Ist der PC aus oder im Standby, kommt weder Antwort noch Meldung – dann ist auch der
  Stop-Loss nicht aktiv. Für echten Dauerbetrieb eignet sich der Python-Bot auf einem Server besser.
- Der Token liegt unverschlüsselt im Browser-Speicher. Wer ihn hat, kann in deinem Namen Nachrichten senden, aber keine Befehle an deinen Bot geben (dafür ist deine Chat-ID nötig).
- Ohne Extra-Einrichtung geht auch: **Chrome-Remote-Desktop** (App auf dem Handy), um den PC mit dem Popup direkt zu bedienen.

## „Der Bot lief die ganze Nacht, aber es gab keinen Trade“
Das ist bei den strengen Standardwerten häufig und **kein Fehler**: Wenn keine Strategie den Backtest besteht, handelt der
Bot absichtlich nicht. Der Tab „Strategien“ zeigt jetzt unter **„Warum (nicht)?“**, woran es scheiterte (z. B. „Sharpe
zu niedrig 33×“), und die „knapp Gescheiterten“. Typische Gründe: Seitwärtsmarkt, und die Kosten pro Trade
(Gebühr 0,10 % + Slippage 0,15 % je Seite ≈ 0,5 % Hin- und Rückweg) fressen bei 15-Minuten-Kerzen den Vorteil auf.

Was du ändern kannst (Optionen):
- **Zeitrahmen 1h oder 30m** statt 15m: weniger Trades, die Kosten fallen weniger ins Gewicht, und die 3000 Kerzen
  Historie reichen weiter zurück (125 statt 31 Tage). Ob das für deine Märkte mehr Zulassungen ergibt, ist ungetestet.
- **Prüfmodus „explore“ (nur Paper):** gelockerte Mindestwerte (Trefferquote ab 35 %, mindestens 8 Trades, Backtest
  mindestens im Plus, Sharpe ≥ 0, Profit Factor ≥ 1,0), damit du den Bot handeln siehst. Ein Knopf **„Regeln lockern (nur Paper)
  & neu prüfen“** unter „Warum (nicht)?“ schaltet ihn um. Die Strategien sind
  dann **nicht bewiesen**, jeder Trade ist im Log als „EXPERIMENTELL“ markiert, ein Banner erinnert dich daran, und der
  Modus ist im Live-Modus technisch gesperrt. Beim Umschalten werden alte Zulassungen verworfen und neu geprüft.
- Die Mindestwerte selbst lockern – das macht Trades häufiger, aber nicht besser.

## Markt-Scan: viele Märkte, der Bot entscheidet
Der Bot scannt **11 Märkte** (SOL, BTC, ETH, JUP, JTO, PYTH, RAY, RENDER, HNT, ORCA, W – nur liquide Hauptwerte, keine
Memecoins), testet jede der 33 Strategie-Varianten an jedem Markt (rund 360 Tests, dauert wenige Sekunden) und aktiviert
automatisch die **5 besten** (je Strategietyp und Markt höchstens eine). Das wiederholt er alle 24 Stunden und tauscht
die aktiven Strategien selbst aus. Ein Klick auf **„Alle 11 Märkte scannen & besten 5 aktivieren“** im Tab „Strategien“
startet den Scan sofort.

- **Kursdaten:** Live von Kraken, Historie von Bitstamp, Coinbase oder Kraken (die erste Quelle mit genug Kerzen). Märkte,
  die dort nicht (unter diesem Namen) gelistet sind, werden **übersprungen und unter „Probleme“ gemeldet**. Börsensymbole und
  Token-Adressen der neuen Märkte stammen aus meinem Gedächtnis und sind nicht verifiziert – welche Märkte tatsächlich laufen,
  zeigt dir der erste Scan.
- **Je mehr Tests, desto mehr Zufallstreffer:** Bei 360 Tests besteht allein durch Glück die eine oder andere Strategie.
  Deshalb muss jede zugelassene Strategie auch auf den zuletzt ungesehenen 30 % der Daten im Plus liegen, und die Auswahl wird
  täglich neu geprüft. Ein Garant für künftige Gewinne ist das nicht.
- Thin liquidity: Kleinere Token haben auf Solana oft wenig Handelstiefe. Der Bot bricht Swaps bei > 1 % Preisabweichung oder
  zu hoher Preisauswirkung ab; das kann dazu führen, dass Signale nicht ausgeführt werden.

## Mehrere Märkte gleichzeitig
- Jeder Markt wird **einzeln** analysiert und gebacktestet; eine Strategie wird je Markt zugelassen oder abgelehnt
  (Tab „Strategien“ zeigt die Spalte „Markt“). Höchstens `maxOpenPositions` Positionen gleichzeitig (Standard 2) – das Limit,
  das Tagesverlust-Limit und das Risiko pro Trade (1 %) gelten über alle Märkte zusammen. Fällt die Datenquelle eines
  Marktes aus, laufen die anderen weiter.
- **BTC und ETH auf Solana sind Wrapped-Token (Wormhole)** mit deutlich dünnerer Liquidität als SOL: mehr Slippage,
  größere Abweichung vom Börsenkurs. Die Token-Adressen stammen aus meinem Gedächtnis und sind **nicht verifiziert** –
  prüfe sie in den Optionen gegen einen Solana-Explorer (dort auch überschreibbar). Schutz: Nachkommastellen werden von der Chain gelesen, und
  jeder Swap bricht ab, wenn der Jupiter-Preis um mehr als 1 % vom Börsenkurs abweicht (das fängt auch eine falsche Adresse ab).
  Wenn BTC/ETH häufig an diesem Abgleich scheitern, schalte sie ab und handle nur SOL.
- Beobachtet werden die Märkte über Kraken-Kurse in USD, gehandelt wird gegen USDC (1 USDC ≈ 1 USD).

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
node --test extension/test/*.test.mjs                       # 29 Tests (Node 20+)
python extension/test/make_parity_fixture.py                # Python-Referenzwerte neu erzeugen
python extension/test/make_sign_fixture.py                  # Signatur-Referenz (solders) neu erzeugen
```
Aufbau: `background.js` (Alarm alle 30 s, Nachrichten), `popup.*`/`options.*` (Oberfläche), `lib/` mit `indicators`,
`strategies`, `backtest`, `risk`, `engine`, `pipeline`, `research`, `data`, `solana` (Jupiter/Signatur/Paper-Broker),
`vault` (Verschlüsselung), `controller`, `nacl.js` (tweetnacl 1.0.3, gemeinfrei, als ES-Modul verpackt).
