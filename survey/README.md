# Massen-Test aller Strategien

Testet die 34 Strategie-Varianten des Bots (26 Typen) auf ~45 Märkten: Krypto, Gold/Silber/Kupfer/Platin, Öl/Gas, Indizes, 15 Aktien, Forex.

```
pip install -r survey/requirements.txt
python survey/survey.py --interval 1d     # ca. 10 Jahre Tageskerzen (schnell, wenige Minuten)
python survey/survey.py --interval 1h     # ca. 2 Jahre Stundenkerzen (länger)
```

Ergebnis: `survey/out/1d/ergebnisse.txt` (klein, zum Weitergeben) sowie `alle_laeufe.csv` und `je_strategie.csv` (alle Zahlen).
Zum Testen ohne Internet: `--demo --limit 6` (Zufallsdaten, Ergebnisse bedeutungslos).

Bewertung je Strategie: Anteil der Märkte im Plus, Anteil mit Gewinn in **beiden Zeithälften** (Beständigkeit), Vergleich mit Kaufen-und-Halten, Median von Sharpe, Rendite, Trefferquote, Profitfaktor, Drawdown. Läufe mit zu wenigen Trades zählen nicht.

Grenzen: nur Long (kein Leerverkauf), Yahoo-Daten (angepasste Kurse, bei Futures GC=F usw. durchlaufende Kontrakte), grobe Kostenannahmen je Klasse, 1 % Risiko je Trade (Renditen in % des Kontos sind deshalb klein). Viele Tests auf denselben Daten: Spitzenwerte einzelner Läufe sind teils Zufall – deshalb zählt die Beständigkeit über viele Märkte.

## Märkte zu den Strategien auswählen

```
python survey/pick.py --interval 1d
```
Liest `alle_laeufe.csv` und schreibt `survey/out/1d/markt_auswahl.txt`: je Strategie die Märkte, auf denen sie in beiden Zeithälften Gewinn machte (Profitfaktor >= 1,2, genug Trades), plus eine Liste der Märkte, die zu den meisten Strategien passen. Hinweis: Märkte nachträglich nach den besten Zahlen auszusuchen überschätzt den Edge; deshalb zählt nur „robust" in beiden Hälften.

## Strategien prüfen (Aufnahme-Checkliste)
Regeln: `STRATEGIE_CHECKLISTE.md` im Projektordner. Automatisch:
```
python survey/survey.py --interval 1d
python survey/survey.py --interval 1d --years 2
python survey/survey.py --interval 1d --cost-mult 2        (Kostenstress: doppelte Gebühren)
python -m survey.pruefen --runs 1d 1d_2y --stress 1d_x2
```
Ergebnis: `survey/out/pruefung.txt` mit ✔/✘ je Regel und dem Urteil ÜBERNEHMEN / BEOBACHTEN / ABLEHNEN.

## Tiefensuche (ca. 20 Minuten gezielt suchen)
```
python -m survey.tiefensuche --interval 1d --minutes 20
```
Testet über die Suchzeit Tausende zufällige Parameter-Kombinationen aller Strategie-Typen auf allen Märkten. Gesucht wird nur auf dem **Trainingsteil** (erste 60 %),
die Besten werden danach auf dem **unbekannten Testteil** geprüft, mit **doppelten Kosten** und mit **leicht veränderten Parametern** (Nachbarn).
Ergebnis: `survey/out/tiefensuche_1d/ergebnisse.txt` (mit Ehrlichkeits-Check: wie viel vom Trainings-Spitzenwert im Test übrig bleibt), `kandidaten.json`, `alle_konfigurationen.csv`.
Mehr Suchzeit: `--minutes 40`. Zwischenstand und Abbruch: Strg+C wertet das bisher Gefundene aus. Andere Zeitrahmen: `--interval 4h` (Daten: 2 Jahre).
Gefundene Kandidaten danach wie jede neue Strategie durch `STRATEGIE_CHECKLISTE.md` schicken (zweiter Zeitraum, `survey.pruefen`, Demo-Abnahme).

## Nachprüfung der Kandidaten (Ist der Erfolg echt?)
```
python -m survey.nachpruefen --interval 1d
```
Liest `kandidaten.json` der Tiefensuche und prüft über die ganze Reihe: **Edge gegen Zufalls-Einstiege** (gleiche Ausstiege, zufällige Einstiege), **Jahre im Plus**,
**Trades je Markt und Jahr**, Drawdown und **Parameter-Nachbarn**. Urteil: ROBUST / ROBUST, ABER SELTEN / SCHWACH. Ergebnis: `survey/out/nachpruefung_1d/ergebnisse.txt`.
Hintergrund: Ist der Testzeitraum für Kauf-Strategien günstig, sind auch Zufalls-Einstiege profitabel; nur der Abstand dazu zählt als echter Beitrag der Strategie.
