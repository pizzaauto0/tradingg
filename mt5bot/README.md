# MT5-Bot (Python, Demo-Konto)

Verbindet sich über das Paket `MetaTrader5` mit deinem laufenden MetaTrader-5-Terminal (nur Windows) und führt **mehrere Profile in einem Prozess** aus.
Aufgebaut nach dem Muster deiner drei Beispiel-Bots (Haupt-Bot, David V2, Divergenz Gold/Silber), die alle als Profil enthalten sind.

## Start
```
pip install MetaTrader5 pandas numpy pyyaml
python -m mt5bot.run          (im Projektordner)   oder   mt5bot\start_bot.bat
```
Vorher: MetaTrader 5 starten, **Demo-Konto** einloggen, oben „Algo-Handel" grün. Stoppen mit Strg+C (Stop-Loss/Take-Profit bleiben beim Broker).

## Profile (`mt5bot/config.py`, `enabled` ein-/ausschalten)
| Profil | Strategie | Standard |
|---|---|---|
| `video` | Video-Methode: Linie steigt + Rücksetzer bis zur Linie (`ma_pullback`, 50/10) auf XAUUSD, XAGUSD, XPTUSD H4 | **an** |
| `connors_d1` | Connors RSI(2) auf Gold D1 | aus |
| `haupt_rsi` | wie 1-Haupt-Bot: Kurs über EMA150, RSI(14) kreuzt über 35 | aus |
| `david_v2` | wie 2-David-V2: mit Neutralzone, Long **und** Short, 0,5 % Risiko | aus |
| `divergenz` | wie 3-Divergenz: Gold fällt gegenüber Silber zurück und holt auf | aus |

Jedes Profil kann auch jede andere der 27 Strategie-Typen aus `tradingbot/strategies.py` nutzen (`{"type": ..., "params": ...}`) – dieselbe Logik wie in den Massen-Tests.
Jedes Profil braucht eine **eigene Magic Number**; so verwalten mehrere Profile (und andere Bots auf demselben Konto) nur ihre eigenen Positionen.

## Sicherheit (gemeinsam für alle Profile)
- **Nur Demo-Konten** (`ALLOW_REAL_ACCOUNT = False`): auf Echtgeld bricht der Bot beim Start ab.
- Jeder Trade hat **Stop-Loss und Take-Profit**; ein Wächter rüstet fehlenden Schutz nach oder schließt die Position sofort.
- Lotgröße über `order_calc_profit` des Brokers (1 % Risiko, höchstens 2 % erlaubt, abgerundet; Abbruch, wenn das Mindest-Lot zu riskant wäre).
- Gesamt höchstens `MAX_OPEN_POSITIONS`, je Profil und Markt eine Position; **Tagesverlust-Limit** (3 %); **Kill-Switch**: Datei `KILL_SWITCH` im Projektordner anlegen → alle Positionen schließen, keine neuen Trades.
- Entscheidung nur bei neu geschlossenen Kerzen; beim Start keine Alt-Signale.
- Journal `mt5bot_journal.csv`, Log `mt5bot.log`, Lebenszeichen mit Marktzustand alle 15 Minuten.

## Symbolnamen
Manche Broker nennen Gold `GOLD` statt `XAUUSD`: `SYMBOL_ALIASES` in der Konfiguration wird der Reihe nach probiert; was nicht gefunden wird, wird übersprungen.

## Getestet?
Mit einer Attrappe des MetaTrader5-Moduls (`tests/test_mt5bot.py`): Signal → Order mit Schutz und Risikogrenze, Echtgeld-Sperre, Positions-/Tageslimit, Kill-Switch, Schutz-Wächter. Gegen ein echtes Terminal und einen echten Broker wurde es noch **nicht** ausgeführt.
