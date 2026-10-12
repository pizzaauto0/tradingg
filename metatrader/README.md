# MetaTrader-5-Expert-Advisor: Video-Methode

`VideoPullbackEA.mq5` kauft (und optional verkauft) nach den zwei Fragen aus dem Video:
1. Steigt die lange Durchschnittslinie (Trend über Wochen)?
2. Fiel der Kurs bis an die Linie zurück und schließt die Kerze wieder darüber (bullisch)?

Dann Kauf mit Stop-Loss (ATR × 2) und Ziel (2 × Risiko). Ausstieg auch, wenn der Kurs 3 % unter die Linie fällt (Trend gebrochen).
Short ist das Spiegelbild und standardmäßig aus (`AllowShort`).

## Installation (MetaTrader 5, nicht MT4)
1. MT5 öffnen → Datei → Datenordner öffnen → `MQL5\Experts` → `VideoPullbackEA.mq5` hineinkopieren.
2. MetaEditor (F4) öffnen → Datei öffnen → **Kompilieren (F7)**. Fehler bitte mir schicken.
3. Im Navigator „Expert Advisors" → Rechtsklick → Aktualisieren.
4. Chart des Marktes öffnen (z. B. XAUUSD, Zeitrahmen **D1** oder H4), EA aufs Chart ziehen, „Algo-Handel" oben aktivieren.

## Sicherheit
- Handelt **nur auf Demo-Konten** (`AllowLiveAccount=false`). Auf einem echten Konto bricht der EA beim Start ab.
- Risiko 1 % je Trade (maximal 2 erlaubt), Tagesverlust-Limit 5 %, höchstens 1 offene Position, Stop-Loss bei jedem Trade.
- `TradingEnabled=false` = Not-Aus für neue Trades.
- Entscheidung nur einmal pro neuer Kerze auf Basis der geschlossenen Kerze (kein Repainting).

## Testen
Strategietester (Strg+R): Expert `VideoPullbackEA`, Symbol z. B. XAUUSD, Zeitrahmen D1, Modell „Jeder Tick", mindestens 5 Jahre. Danach mehrere Wochen auf einem Demo-Konto. Der Code wurde nicht mit MetaEditor kompiliert oder getestet (dort nicht verfügbar) – bitte zuerst kompilieren.

## Hinweis zu „Indikator"
Ein MetaTrader-Indikator zeichnet nur, er kann nicht handeln. Zum Kaufen/Verkaufen braucht man einen Expert Advisor. Dieser EA zeigt die Linie, Kauf-/Verkaufspfeile und einen Statustext im Chart.
