# Aufnahme-Checkliste für Strategien

Eine Strategie kommt nur in den Bot, wenn sie diese Liste besteht. Die Latte orientiert sich an den Strategien, die wir schon haben
(Werte aus deinen echten Massen-Tests, siehe Abschnitt „Vorlagen"). Automatisch prüfen: `python -m survey.pruefen --runs 1d 1d_2y --stress 1d_x2`
(Programm liest die Ergebnisse von `survey/survey.py`, Ergebnis in `survey/out/pruefung.txt`).

## 1. Muss-Regeln (alle erfüllen, sonst nicht aufnehmen)
Alle Zahlen **nach Gebühren und Slippage** (der Test rechnet beides je Seite ein, Werte siehe Abschnitt 4).

| # | Regel | Schwelle | Warum |
|---|---|---|---|
| M1 | **Genug Märkte** getestet (mit genug Trades) | ≥ 15 | Eine Strategie, die nur auf 3 Märkten läuft, ist meist Zufall oder nachträglich ausgesucht. |
| M2 | **Genug Trades** insgesamt | ≥ 150 (über alle Märkte) | Wenige Trades sagen nichts aus. Je Markt zählen nur Läufe ab 15 Trades (Tageskerzen) bzw. 25 (4h). |
| M3 | **Gewinn nach Kosten** | Median-Rendite > 0 % | Muss auch nach Gebühren im Plus enden. |
| M4 | **Profitfaktor nach Kosten** (Summe Gewinne ÷ Summe Verluste) | Median ≥ 1,10 | Unter 1,10 frisst schon ein etwas schlechterer Spread den Vorsprung. |
| M5 | **Märkte im Plus** | ≥ 60 % | Eine echte Idee funktioniert auf der Mehrheit der Märkte, nicht nur auf wenigen. |
| M6 | **Trefferquote netto über Break-even** | Median ≥ Break-even + 5 Prozentpunkte | Siehe Abschnitt 3: Trefferquote allein sagt nichts, sie muss zum Stop/Ziel-Verhältnis passen. |
| M7 | **Zweiter Zeitraum/Zeitrahmen bestätigt** | M1–M6 auch in einem zweiten Lauf (z. B. 2 Jahre Tageskerzen oder 4h) | Schützt davor, dass die Strategie nur zu einer Marktphase passt. |
| M8 | **Kostenstress** | bei **doppelten** Gebühren und Slippage: Median-Rendite > 0 und Profitfaktor ≥ 1,0 | Dein Broker ist vermutlich teurer als meine Annahme. |

## 2. Soll-Regeln (erhöhen das Vertrauen, Verfehlen = Hinweis)
| # | Regel | Schwelle |
|---|---|---|
| S1 | Gewinn in **beiden Zeithälften** auf dem Markt | ≥ 40 % der Märkte |
| S2 | Sharpe-Ratio (Median) | ≥ 0,15 |
| S3 | Max. Drawdown (Median, bei 1 % Risiko je Trade) | ≤ 10 % |
| S4 | Handelshäufigkeit | ≥ 15 Trades je Markt im Test (damit der Bot überhaupt handelt) |
| S5 | Parameter-Nachbarn ähnlich | Ändert man Linie/Schwelle leicht (z. B. 50→60), bleibt das Ergebnis ähnlich. Ein Ausreißer ist Überanpassung. |
| S6 | Idee in einem Satz erklärbar | z. B. „Trend steigt + kurzer Rücksetzer → kaufen". Strategien, die man nicht erklären kann, brechen unbemerkt. |

## 3. Trefferquote mit Gebühren richtig lesen
Die **Trefferquote netto** im Test zählt einen Trade nur als Gewinn, wenn nach Gebühren und Slippage etwas übrig bleibt.
Ob sie reicht, hängt vom **Ziel/Stop-Verhältnis (rr)** ab: Ziel = rr × Stop-Abstand.

**Break-even-Trefferquote = (1 + k) ÷ (1 + rr)**, wobei k = Kosten je Trade in Vielfachen des Stop-Abstands (R).

| Ziel/Stop (rr) | ohne Kosten | mit typischen Kosten (k ≈ 0,1) | Mindest-Trefferquote laut Checkliste (+5 Punkte) |
|---|---|---|---|
| 1,0 | 50,0 % | 55 % | **≈ 60 %** |
| 1,5 | 40,0 % | 44 % | **≈ 49 %** |
| 2,0 | 33,3 % | 36,7 % | **≈ 42 %** |
| 3,0 | 25,0 % | 27,5 % | **≈ 33 %** |

Beispiel Gold (H4): Stop = 2 × ATR ≈ 1,5 % Kurs, Kosten je Trade ≈ 0,12 % ⇒ k ≈ 0,08. Ein Ziel von 2 R braucht rund 36 % Trefferquote, um nur auf Null zu kommen.
**Eine hohe Trefferquote ist kein Qualitätsmerkmal.** Strategien mit 65–80 % Treffern (Connors RSI(2), Pullbacks) haben kleine Gewinne und seltene große Verluste.
Maßgeblich sind **Profitfaktor** (M4) und **Gewinn nach Kosten** (M3). Die Trefferquote prüft nur, ob das Ganze plausibel ist (M6; bei Strategien mit Ausstiegssignal ist sie nur eine grobe Orientierung).

## 4. Kosten, mit denen getestet wird (je Seite, in %)
| Klasse | Gebühr | Slippage |
|---|---|---|
| Krypto | 0,10 | 0,05 |
| Metalle | 0,03 | 0,03 |
| Energie | 0,03 | 0,05 |
| Indizes | 0,02 | 0,02 |
| Aktien | 0,02 | 0,03 |
| Forex | 0,005 | 0,01 |
Prüfe vor der Aufnahme den **echten Spread und Swap** deines Brokers für den Markt (Marktübersicht in MetaTrader). Liegen sie deutlich höher, gilt der Kostenstress (M8) als Maßstab.

## 5. Umsetzbarkeit im Bot (ja/nein)
- [ ] Regeln beruhen nur auf **geschlossenen Kerzen** (kein Blick in die Zukunft, kein Repainting).
- [ ] Jeder Trade hat **Stop-Loss und Take-Profit**, Risiko höchstens 1 % je Trade (2 % hartes Maximum).
- [ ] Strategie ist als **feste Regel** formulierbar (keine News-, Bauch- oder „Smart-Money"-Deutung).
- [ ] Der Markt ist beim Broker verfügbar (Symbol in MetaTrader sichtbar, Handelszeiten passen zum Zeitrahmen).
- [ ] Sie ist in `tradingbot/strategies.py` **und** in der Extension (`extension/lib/strategies.js`) gleich umgesetzt, falls beide sie nutzen sollen (Parity-Test).

## 6. Rote Flaggen (sofort ablehnen oder misstrauisch sein)
- Trefferquote über 85 % **bei kleinem Gesamtgewinn** (typisch für „kleines Ziel, riesiger Stop" – ein einziger Verlust löscht alles aus).
- Weniger als 30 Trades insgesamt, oder fast der ganze Gewinn aus 1–3 Trades.
- Nur auf **einem** Markt oder einem Zeitraum gut; Parameter genau auf diesen Markt „optimiert".
- Martingale, Grid, Verdoppeln nach Verlust, Stop-Loss entfernen oder verschieben, „bis es zurückkommt".
- Der Gewinn kommt aus der Zeitphase (z. B. nur im Krypto-Bullenmarkt 2020/21). Ein zweiter Zeitraum (M7) entlarvt das.
- Viele Strategien auf denselben Daten ausprobiert und die schönste genommen: Das Video warnt zu Recht davor. Gegenmittel sind M1, M5, M7, M8 und der Demo-Test.

## 7. Ablauf (so kommt eine Strategie in den Bot)
1. Regeln aufschreiben (Abschnitt 5 abhaken), in `tradingbot/strategies.py` eintragen und mit Tests absichern.
2. `python survey/survey.py --interval 1d` (10 Jahre) und `--interval 1d --years 2` (letzte 2 Jahre) und optional `--interval 4h`.
3. Kostenstress: `python survey/survey.py --interval 1d --cost-mult 2`.
4. `python -m survey.pruefen --runs 1d 1d_2y --stress 1d_x2` → Urteil **ÜBERNEHMEN / BEOBACHTEN / ABLEHNEN**.
4b. Neue Idee durch Parametersuche gefunden (`python -m survey.tiefensuche`)? Dann zusätzlich `python -m survey.nachpruefen`: **Edge gegen Zufalls-Einstiege** muss ≥ +0,20 sein, mindestens 70 % der Jahre im Plus, Nachbar-Parameter PF ≥ 1,05. Sonst steckt der Gewinn im steigenden Markt und nicht in der Strategie.
5. `python survey/pick.py --interval 1d` (oder `python -m survey.profil_erzeugen`) wählt die Märkte, auf denen sie robust ist (nur dort einsetzen).
6. **Demo-Abnahme:** mindestens 4 Wochen und 10 Trades auf dem Demo-Konto. Trefferquote und Profitfaktor müssen grob zum Test passen (Trefferquote ±15 Punkte, Profitfaktor > 1). Auswertung: `mt5bot_trades.csv` oder Telegram `/stats`.
7. Erst danach Echtgeld erwägen, mit kleinem Betrag und weiter mit Stop-Loss und Tageslimit.

## 8. Vorlagen: Werte unserer bisherigen Strategien (10 Jahre Tageskerzen, 42 Märkte, nach Kosten)
| Strategie | Märkte im Plus | beide Hälften | Profitfaktor | Trefferquote | Drawdown | Trades/Markt | Anmerkung |
|---|---|---|---|---|---|---|---|
| Connors RSI(2) (Stop 3, Ziel 1) | 83 % | 55 % | 1,40 | 68 % | 2,0 % | 32 | Auch im 2-Jahres-Test beständig |
| Breakout 55/20 | 68 % | 58 % | 1,28 | 41 % | 6,4 % | 38 | Zuletzt (2 Jahre) schwächer |
| Williams %R (14, 90/30) | 71 % | 40 % | 1,14 | 56 % | 6,8 % | 56 | Im 2-Jahres-Test stark (80 % im Plus) |
| VWAP-Rückkehr | 86 % | 39 % | 1,22 | 59 % | 7,6 % | 69 | 2 Jahre: nur 57 % im Plus |
| IBS 0,2/0,8 | 67 % | 43 % | 1,10 | 60 % | 8,6 % | 268 | Kostenempfindlich (viele Trades) |
| Video-Methode (50er Linie, Steigung 10) | siehe `pick.py` | 14 von 42 Märkten robust auf 1d **und** 4h | – | ≈ 40–50 % | ≈ 4–5 % | 17–49 | Beständig auf beiden Zeitrahmen |
| *Abgelehnt:* Heikin-Ashi, CCI, Stochastik, MACD-Cross | 55–60 % | 29–37 % | 1,03–1,15 | – | – | – | Profitfaktor zu niedrig bzw. zu wenige Märkte im Plus |

Alle Strategien auf **Stundenkerzen** (2 Jahre) fielen durch (Median-Sharpe negativ): Mehr Trades = mehr Kosten. Das ist die wichtigste Erfahrung aus den Tests.

## 9. Was dieses Prüfen **nicht** beweist
Backtests sind Vergangenheit. Die Auswahl nach Ergebnis bleibt ein Rest-Risiko (viele Tests, wenige Daten). Deshalb zählen Beständigkeit, zweiter Zeitraum, Kostenstress und die Demo-Abnahme. Keine Strategie ist dadurch ein sicherer Gewinn.
