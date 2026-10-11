# Strategie-Katalog und Prüfung

Der Bot kennt **25 Strategietypen** in **33 festen Varianten** (Python-Bot und
Browser-Extension identisch – das prüfen die Paritätstests). Jede Variante wird auf historischen Daten mit Gebühren
und Slippage gebacktestet. Zugelassen wird nur, was **alle** Mindestwerte erfüllt – standardmäßig u. a.
**Trefferquote ≥ 55 %**, Sharpe ≥ 1, Profit Factor ≥ 1,2, begrenzter Drawdown und positive Out-of-Sample-Rendite.
Von den zugelassenen Strategien handeln nur die **5 besten aktiv** (nach Sharpe, je Strategietyp und Markt höchstens
eine); die übrigen sind Reserve. Neu geprüft wird alle 24 Stunden.

Jede Strategie darf eigene Ausstiegsabstände haben: `stop_mult` (Stop = x · ATR) und `rr` (Ziel = rr · Risiko).
Varianten mit `rr=1.0` zielen auf eine höhere Trefferquote.

### Trendfolge

| Typ | Idee | Quelle | Marktphase | Varianten |
|---|---|---|---|---|
| `ma_crossover` | Schnelle EMA kreuzt langsame EMA nach oben; Ausstieg bei Gegenkreuzung. | Klassische Trendfolge (z. B. Murphy, Technical Analysis of the Financial Markets) | uptrend | 2 |
| `triple_ema` | Drei EMAs ordnen sich bullisch (schnell > mittel > langsam); Ausstieg, wenn schnell < mittel. | Trendfolge mit EMA-Ausrichtung (u. a. Elder, Triple Screen) | uptrend | 1 |
| `macd_cross` | MACD kreuzt seine Signallinie nach oben; Ausstieg bei Gegenkreuzung. | Gerald Appel (1970er), MACD | uptrend | 1 |
| `macd_zero` | MACD-Linie kreuzt die Nulllinie nach oben; Ausstieg unter null. | Gerald Appel, MACD-Nulllinie | uptrend | 1 |
| `adx_di` | +DI kreuzt -DI nach oben bei starkem Trend (ADX über Schwelle); Ausstieg, wenn -DI > +DI. | J. Welles Wilder, New Concepts in Technical Trading Systems (1978) | uptrend | 1 |
| `supertrend` | Supertrend (ATR-Band) dreht auf aufwärts; Ausstieg, wenn er auf abwärts dreht. | Olivier Seban, Supertrend-Indikator | uptrend | 1 |
| `parabolic_sar` | Parabolic SAR wechselt unter den Kurs (Aufwärtstrend); Ausstieg beim Wechsel darüber. | J. Welles Wilder (1978) | uptrend | 1 |
| `ichimoku` | Tenkan kreuzt Kijun nach oben, Kurs über der Wolke; Ausstieg, wenn Tenkan < Kijun. | Goichi Hosoda, Ichimoku Kinko Hyo | uptrend | 1 |
| `heikin_ashi` | N bullische Heikin-Ashi-Kerzen in Folge; Ausstieg bei der ersten bärischen. | Heikin-Ashi (japanische Kerzentechnik), u. a. Dan Valcu | uptrend | 1 |
| `roc_momentum` | Kursänderung über N Kerzen (Rate of Change) steigt über eine Schwelle; Ausstieg, wenn sie negativ wird. | Momentum-/ROC-Strategie (u. a. Jegadeesh & Titman zu Momentum) | uptrend | 1 |

### Ausbruch

| Typ | Idee | Quelle | Marktphase | Varianten |
|---|---|---|---|---|
| `breakout` | Ausbruch über das Hoch der letzten N Kerzen; Ausstieg unter dem Tief der letzten M Kerzen (Donchian). | Richard Donchian / Turtle-Trader (Dennis & Eckhardt) | uptrend | 2 |
| `squeeze_breakout` | Bollinger-Bänder lagen innerhalb der Keltner-Kanäle (Squeeze) und öffnen sich mit Kurs über der Mitte. | John Carter, TTM Squeeze (Mastering the Trade) | uptrend, sideways | 1 |
| `inside_bar` | Nach einer Innenstab-Kerze schließt der Kurs über dem Hoch der Mutterkerze; Ausstieg unter der EMA. | Price-Action-Muster Inside Bar (u. a. Al Brooks) | uptrend | 1 |
| `range_support` | Kauf nahe der Unterkante einer Handelsspanne bei bullischer Kerze, Ausstieg im oberen Teil der Spanne. | Unterstützungs-/Widerstandshandel (trading.de) | sideways | 1 |
| `session_breakout` | Spanne der ersten Handelsstunden (UTC) – Kauf beim ersten Ausbruch darüber, Ausstieg zur Schlussstunde oder unter der Spanne (z. B. London-Breakout). | Opening-Range-/London-Breakout (u. a. Toby Crabel, Day Trading with Short Term Price Patterns) | uptrend, downtrend, sideways | 1 |

### Mean Reversion (typisch hohe Trefferquote)

| Typ | Idee | Quelle | Marktphase | Varianten |
|---|---|---|---|---|
| `rsi_reversion` | Kauf bei überverkauftem RSI, Verkauf bei Erholung. | J. Welles Wilder, RSI (1978) | sideways | 2 |
| `connors_rsi2` | Kurs über dem langen SMA (Trendfilter) und sehr kurzer RSI stark überverkauft; Ausstieg über kurzem SMA. | Larry Connors & Cesar Alvarez, Short Term Trading Strategies That Work (2008) | uptrend, sideways | 2 |
| `ibs_reversion` | Internal Bar Strength: Schluss nahe am Kerzentief -> Kauf; Schluss nahe am Hoch -> Verkauf. | IBS-Effekt (u. a. Pagonidis, 'The IBS Effect', NAAIM) | uptrend, sideways | 2 |
| `bollinger_reversion` | Kauf unter dem unteren Bollinger-Band, Ausstieg an der Mittellinie. | John Bollinger, Bollinger on Bollinger Bands (2001) | sideways | 2 |
| `keltner_reversion` | Kauf unter dem unteren Keltner-Kanal (EMA - x * ATR), Ausstieg an der EMA. | Chester Keltner (1960) / Linda Raschke (ATR-Variante) | sideways | 1 |
| `zscore_reversion` | Kurs liegt mehr als X Standardabweichungen unter dem Mittelwert; Ausstieg bei Rückkehr. | Statistische Mean Reversion (z. B. Chan, Algorithmic Trading, 2013) | sideways | 2 |
| `williams_r` | Williams %R unter -oversold -> Kauf; über -exit_level -> Verkauf. | Larry Williams, Williams %R (1973) | sideways | 1 |
| `stochastic` | %K kreuzt %D nach oben im überverkauften Bereich; Ausstieg im überkauften Bereich. | George Lane, Stochastik-Oszillator (1950er) | sideways | 1 |
| `cci_reversion` | Commodity Channel Index unter -level -> Kauf; über exit_level -> Verkauf. | Donald Lambert, CCI (1980) | sideways | 1 |
| `vwap_reversion` | Kurs liegt X % unter dem gleitenden VWAP -> Kauf; Ausstieg bei Rückkehr zum VWAP (braucht Volumen). | VWAP-Reversion (institutionelle Ausführung, u. a. Berkowitz et al. 1988) | sideways | 1 |
| `trend_pullback` | Im Aufwärtstrend (Kurs über langer EMA) nach N fallenden Schlusskursen kaufen; Ausstieg über kurzem SMA. | Buy-the-Dip im Trend (u. a. Connors, 'Multiple Days Down') | uptrend | 2 |

## Warum die Trefferquote allein täuscht

Eine hohe Trefferquote ist leicht zu erreichen: nahes Ziel, weiter Stop. Dann gewinnt man oft wenig und verliert
selten viel – unterm Strich häufig ein Verlust. Deshalb verlangt der Bot zusätzlich Gewinn, Sharpe, Profit Factor
und eine Out-of-Sample-Prüfung. Zwei Belege:

- In der Recherche zeigt ein Connors-RSI(2)-Backtest auf dem Nasdaq 100 75 % Trefferquote, aber durchschnittlich
  1,58 % Gewinn gegen 3,11 % Verlust und nur +27 % gegen +528 % Buy-and-hold in zehn Jahren
  ([Backtrex](https://backtrex.com/en/backtests/connors-rsi-2-nasdaq-100)). Ein London-Breakout auf EUR/USD lag bei
  36 % Trefferquote und Verlust ([Backtrex](https://backtrex.com/en/backtests/london-breakout-eur-usd)). Die meisten
  im Netz genannten Trefferquoten sind Herstellerangaben ohne unabhängige Prüfung
  ([WealthLab IBS](https://wealth-lab.com/blog/build-a-profitable-mean-reversion-strategy-using-the-ibs-indicator),
  [Quantified Strategies, Williams %R](https://quantifiedstrategies.substack.com/p/williams-r-trading-strategy-81-win)).
- Bei Krypto-Gebühren (ca. 0,6 % pro Kauf+Verkauf) werden sehr nahe Ziele sogar zu Verlusten, obwohl sie „getroffen"
  werden (Test `test_tight_target_with_high_fees_turns_hits_into_losses`).

## Ergebnis auf echten Daten (EUR/USD, 1 Stunde)

Echte Kursdaten aus den Testdaten der Bibliothek *backtesting.py* (5000 Stundenkerzen, April 2017 – Februar 2018,
ein starker Aufwärtstrend des Euro). Forex-Konfiguration: Long und Short, IBKR-Kosten, 1 % Risiko je Trade.
Selbst nachprüfen: `python main.py --config config.forex.yaml evaluate datei.csv --symbol EUR/USD`
(in der Konfig `timeframe: 1h` setzen).

```
Daten: 5000 Stundenkerzen 2017-04-19 bis 2018-02-07, EUR/USD 1.0722 -> 1.2290
Strategie                                                              Trades Treffer% Rendite%  MaxDD%  Sharpe    PF  Ergebnis
trend_pullback(trend=100,down_bars=4,exit_ma=5,rr=1.0)                     47     68.1     1.49    2.02    0.58  1.22  abgelehnt: Sharpe 0.58 < 1.0
trend_pullback(trend=200,down_bars=3,exit_ma=5)                           100     63.0    -2.16    5.22   -0.45  0.88  abgelehnt: Rendite -2.16% < 1.0%; Sharpe -0.45 < 1.0
connors_rsi2(trend=200,rsi_period=2,oversold=10.0,exit_ma=5)              198     62.1    -3.34   11.05   -0.40  0.92  abgelehnt: Rendite -3.34% < 1.0%; Max Drawdown 11.05% > 10.0%
connors_rsi2(trend=200,rsi_period=2,oversold=5.0,exit_ma=5,stop_mult=3.0,rr=1.0)     97     61.9    -3.60    6.81   -0.90  0.76  abgelehnt: Rendite -3.60% < 1.0%; Sharpe -0.90 < 1.0
zscore_reversion(period=30,entry_z=2.5,exit_z=-0.5,rr=1.0)                 77     58.4    -2.74    6.48   -0.38  0.91  abgelehnt: Rendite -2.74% < 1.0%; Sharpe -0.38 < 1.0
bollinger_reversion(period=20,num_std=2.5,stop_mult=3.0,rr=1.0)           101     58.4    -4.82    9.77   -0.74  0.85  abgelehnt: Rendite -4.82% < 1.0%; Sharpe -0.74 < 1.0
ibs_reversion(low=0.1,high=0.7,rr=1.0)                                    526     56.5    -5.57   14.10   -0.52  0.94  abgelehnt: Rendite -5.57% < 1.0%; Max Drawdown 14.10% > 10.0%
stochastic(k=14,d=3,oversold=20.0,overbought=80.0)                         95     55.8     0.55    9.95    0.12  1.01  abgelehnt: Rendite 0.55% < 1.0%; Sharpe 0.12 < 1.0
ibs_reversion(low=0.2,high=0.8)                                           721     55.5   -21.77   27.66   -1.64  0.86  abgelehnt: Rendite -21.77% < 1.0%; Max Drawdown 27.66% > 10.0%
bollinger_reversion(period=20,num_std=2.0)                                177     55.4    -8.65   15.17   -0.83  0.88  abgelehnt: Rendite -8.65% < 1.0%; Max Drawdown 15.17% > 10.0%
rsi_reversion(period=7,oversold=20.0,exit_level=50.0)                      62     53.2    -7.10   13.29   -1.23  0.71  abgelehnt: Rendite -7.10% < 1.0%; Max Drawdown 13.29% > 10.0%
keltner_reversion(period=20,mult=2.0)                                      81     53.1    -7.82   12.68   -1.07  0.78  abgelehnt: Rendite -7.82% < 1.0%; Max Drawdown 12.68% > 10.0%
williams_r(period=14,oversold=90.0,exit_level=30.0)                       178     52.2   -10.09   19.64   -0.95  0.85  abgelehnt: Rendite -10.09% < 1.0%; Max Drawdown 19.64% > 10.0%
session_breakout(start_hour=7,range_hours=1,exit_hour=16)                 231     49.8     5.53   18.75    0.54  1.07  abgelehnt: Max Drawdown 18.75% > 10.0%; Sharpe 0.54 < 1.0
cci_reversion(period=20,level=150.0,exit_level=0.0)                       181     49.7   -16.40   20.08   -1.61  0.78  abgelehnt: Rendite -16.40% < 1.0%; Max Drawdown 20.08% > 10.0%
rsi_reversion(period=14,oversold=30.0,exit_level=55.0)                     42     45.2    -1.13    7.00   -0.15  0.95  abgelehnt: Rendite -1.13% < 1.0%; Sharpe -0.15 < 1.0
breakout(lookback=55,exit_lookback=20)                                    102     43.1     4.31   16.56    0.48  1.08  abgelehnt: Max Drawdown 16.56% > 10.0%; Sharpe 0.48 < 1.0
zscore_reversion(period=50,entry_z=2.0,exit_z=0.0)                         75     41.3    -7.77   12.56   -0.99  0.81  abgelehnt: Rendite -7.77% < 1.0%; Max Drawdown 12.56% > 10.0%
breakout(lookback=20,exit_lookback=10)                                    124     41.1     6.42   15.12    0.67  1.11  abgelehnt: Max Drawdown 15.12% > 10.0%; Sharpe 0.67 < 1.0
squeeze_breakout(period=20,bb_mult=2.0,kc_mult=1.5)                       114     35.1     3.18    7.95    0.41  1.07  abgelehnt: Sharpe 0.41 < 1.0; Trefferquote 35.1% < 55.0%
ichimoku(tenkan=9,kijun=26,senkou_b=52)                                    40     35.0    -6.72   13.13   -1.09  0.67  abgelehnt: Rendite -6.72% < 1.0%; Max Drawdown 13.13% > 10.0%
parabolic_sar(step=0.02,max_af=0.2)                                        92     33.7    -7.47   13.75   -0.91  0.84  abgelehnt: Rendite -7.47% < 1.0%; Max Drawdown 13.75% > 10.0%
macd_zero(fast=12,slow=26)                                                 12     33.3    -0.70    4.01   -0.19  0.89  abgelehnt: Trades 12 < 20; Rendite -0.70% < 1.0%
macd_cross(fast=12,slow=26,signal=9)                                       76     31.6    -5.23    9.68   -0.79  0.81  abgelehnt: Rendite -5.23% < 1.0%; Sharpe -0.79 < 1.0
triple_ema(fast=8,mid=21,slow=55)                                          53     30.2   -10.73   12.89   -1.54  0.64  abgelehnt: Rendite -10.73% < 1.0%; Max Drawdown 12.89% > 10.0%
heikin_ashi(bars=2)                                                       249     30.1   -20.68   22.67   -2.83  0.64  abgelehnt: Rendite -20.68% < 1.0%; Max Drawdown 22.67% > 10.0%
supertrend(period=10,mult=3.0)                                             10     30.0    -2.47    3.96   -0.72  0.63  abgelehnt: Trades 10 < 20; Rendite -2.47% < 1.0%
roc_momentum(period=12,threshold=1.0)                                       7     28.6    -1.39    2.91   -0.78  0.53  abgelehnt: Trades 7 < 20; Rendite -1.39% < 1.0%
inside_bar(exit_ma=20)                                                     69     26.1    -5.45   12.67   -0.85  0.80  abgelehnt: Rendite -5.45% < 1.0%; Max Drawdown 12.67% > 10.0%
ma_crossover(fast=9,slow=21)                                               20     25.0    -5.17    6.13   -1.30  0.53  abgelehnt: Rendite -5.17% < 1.0%; Sharpe -1.30 < 1.0
ma_crossover(fast=20,slow=50)                                              34     23.5   -12.12   12.55   -2.07  0.47  abgelehnt: Rendite -12.12% < 1.0%; Max Drawdown 12.55% > 10.0%
adx_di(period=14,threshold=25.0)                                           24     20.8    -3.20    5.19   -0.92  0.68  abgelehnt: Rendite -3.20% < 1.0%; Sharpe -0.92 < 1.0
vwap_reversion(period=96,deviation=1.0)                                     0      0.0     0.00   -0.00    0.00  0.00  abgelehnt: Trades 0 < 20; Rendite 0.00% < 1.0%

10 von 33 Varianten mit Trefferquote >= 55 %; davon profitabel (Rendite > 0): 2; zugelassen: 0; aktiv: 0
```

**Fazit:** 10 von 33 Varianten erreichen ≥ 55 % Trefferquote – aber nur 2 davon verdienen überhaupt Geld, und keine
besteht alle Mindestwerte. Mit diesen Daten würde der Bot **nicht handeln**. Das ist gewollt: lieber kein Trade als
ein Trade mit einer Strategie, die nur auf dem Papier gut aussieht. Ein einzelner Zeitraum (hier ein Trendjahr) ist
außerdem nicht repräsentativ; der Bot prüft deshalb regelmäßig neu auf aktuellen Daten.

Für die Kryptomärkte (15 Minuten) standen in der Entwicklungsumgebung keine echten Daten zur Verfügung; die Prüfung
läuft beim ersten Start automatisch auf echten Börsendaten (`python main.py research` bzw. „Strategien neu prüfen“
in der Extension).
