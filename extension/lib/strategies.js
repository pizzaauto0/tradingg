// Strategie-Bibliothek: 25 bekannte Strategien (1:1-Port von tradingbot/strategies.py, Long/Spot).
// Optional pro Strategie: stop_mult (Stop = x * ATR) und rr (Ziel = rr * Risiko) – bestimmt die Trefferquote stark.
// Auch LLM-Vorschläge werden nur als Spezifikation {type, params, regimes} akzeptiert – es wird nie Code ausgeführt.
import { REGIMES, atr, bollinger, dmi, ema, rollMax, rollMean, rollMin, rollStd, rollSum, rolling, rsi, shift } from "./indicators.js";

export const EXIT_SPEC = { stop_mult: ["float", 0.5, 5.0], rr: ["float", 0.5, 5.0] };

const sma = rollMean;
const crossUp = (a, b) => a.map((v, i) => i > 0 && v > b[i] && a[i - 1] <= b[i - 1]);
const lt = (a, b) => a.map((v, i) => v < (Array.isArray(b) ? b[i] : b));
const gt = (a, b) => a.map((v, i) => v > (Array.isArray(b) ? b[i] : b));
const and = (...xs) => xs[0].map((_, i) => xs.every((x) => x[i]));

// ---- Hilfsindikatoren, die nur Strategien brauchen ----
function supertrendDirection(df, n, mult) {
  const { high: h, low: l, close: c } = df, a = atr(df, n), out = new Array(c.length).fill(NaN);
  let fub = NaN, flb = NaN, cur = 0;
  for (let i = 0; i < c.length; i++) {
    if (!Number.isFinite(a[i])) continue;
    const hl2 = (h[i] + l[i]) / 2, ub = hl2 + mult * a[i], lb = hl2 - mult * a[i];
    if (!Number.isFinite(fub)) { fub = ub; flb = lb; cur = c[i] >= hl2 ? 1 : -1; out[i] = cur; continue; }
    const pub = fub, plb = flb;
    fub = ub < pub || c[i - 1] > pub ? ub : pub;
    flb = lb > plb || c[i - 1] < plb ? lb : plb;
    if (cur === -1 && c[i] > pub) cur = 1;
    else if (cur === 1 && c[i] < plb) cur = -1;
    out[i] = cur;
  }
  return out;
}

function psarDirection(df, step, maxAf) {
  const { high: h, low: l, close: c } = df, n = c.length, out = new Array(n).fill(NaN);
  if (n < 3) return out;
  let up = c[1] >= c[0], sar = up ? l[0] : h[0], ep = up ? h[1] : l[1], af = step;
  out[1] = up ? 1 : -1;
  for (let i = 2; i < n; i++) {
    sar = sar + af * (ep - sar);
    if (up) {
      sar = Math.min(sar, l[i - 1], l[i - 2]);
      if (l[i] < sar) { up = false; sar = ep; ep = l[i]; af = step; }
      else if (h[i] > ep) { ep = h[i]; af = Math.min(af + step, maxAf); }
    } else {
      sar = Math.max(sar, h[i - 1], h[i - 2]);
      if (h[i] > sar) { up = true; sar = ep; ep = h[i]; af = step; }
      else if (l[i] < ep) { ep = l[i]; af = Math.min(af + step, maxAf); }
    }
    out[i] = up ? 1 : -1;
  }
  return out;
}

function heikinBull(df) {
  const { open: o, high: h, low: l, close: c } = df, n = c.length;
  const hc = c.map((_, i) => (o[i] + h[i] + l[i] + c[i]) / 4), ho = new Array(n);
  if (n) ho[0] = (o[0] + c[0]) / 2;
  for (let i = 1; i < n; i++) ho[i] = (ho[i - 1] + hc[i - 1]) / 2;
  return hc.map((v, i) => v > ho[i]);
}

function ichimokuLines(df, p) {
  const mid = (n) => { const hh = rollMax(df.high, n), ll = rollMin(df.low, n); return hh.map((v, i) => (v + ll[i]) / 2); };
  const t = mid(p.tenkan), k = mid(p.kijun);
  const spanA = shift(t.map((v, i) => (v + k[i]) / 2), p.kijun), spanB = shift(mid(p.senkou_b), p.kijun);
  return { t, k, top: spanA.map((a, i) => Math.max(a, spanB[i])) };
}

function stochKD(df, p) {
  const hh = rollMax(df.high, p.k), ll = rollMin(df.low, p.k);
  const k = df.close.map((c, i) => (100 * (c - ll[i])) / (hh[i] - ll[i]));
  return { k, d: rollMean(k, p.d) };
}

function sessionSignals(df, p) {
  const n = df.close.length, entry = new Array(n).fill(false), exit = new Array(n).fill(false);
  const s = p.start_hour, e = p.start_hour + p.range_hours, x = p.exit_hour;
  let day = null, rh = -Infinity, rl = Infinity, done = false;
  for (let i = 0; i < n; i++) {
    const d = Math.floor(df.t[i] / 86400000), hr = Math.floor(df.t[i] / 3600000) % 24;
    if (d !== day) { day = d; rh = -Infinity; rl = Infinity; done = false; }
    if (hr >= s && hr < e) { rh = Math.max(rh, df.high[i]); rl = Math.min(rl, df.low[i]); }
    else if (hr >= e && hr < x && !done && Number.isFinite(rh) && df.close[i] > rh) { entry[i] = true; done = true; }
    exit[i] = hr >= x || (Number.isFinite(rl) && hr >= e && df.close[i] < rl);
  }
  return { entry, exit };
}

const zscore = (c, n) => { const m = sma(c, n), sd = rollStd(c, n); return c.map((v, i) => (v - m[i]) / sd[i]); };
const williams = (df, n) => { const hh = rollMax(df.high, n), ll = rollMin(df.low, n); return df.close.map((c, i) => (-100 * (hh[i] - c)) / (hh[i] - ll[i])); };
const typical = (df) => df.close.map((c, i) => (df.high[i] + df.low[i] + c) / 3);
function cci(df, n) {
  const tp = typical(df), ma = sma(tp, n);
  const mad = rolling(tp, n, (w) => { const m = w.reduce((a, b) => a + b, 0) / w.length; return w.reduce((a, b) => a + Math.abs(b - m), 0) / w.length; });
  return tp.map((v, i) => (v - ma[i]) / (0.015 * mad[i]));
}
function vwap(df, n) {
  const tp = typical(df), num = rollSum(tp.map((v, i) => v * df.volume[i]), n), den = rollSum(df.volume, n);
  return num.map((v, i) => v / den[i]);
}
const macdLine = (c, f, s) => { const a = ema(c, f), b = ema(c, s); return a.map((v, i) => v - b[i]); };
const roc = (c, n) => { const p = shift(c, n); return c.map((v, i) => (v / p[i] - 1) * 100); };

// ---- Strategie-Definitionen ----
const T = ["uptrend"], S = ["sideways"], TS = ["uptrend", "sideways"], ALL = ["uptrend", "downtrend", "sideways"];

export const STRATEGY_TYPES = {
  ma_crossover: {
    defaultRegimes: T, paramSpec: { fast: ["int", 3, 50], slow: ["int", 10, 200] },
    description: "Schnelle EMA kreuzt langsame EMA nach oben; Ausstieg bei Gegenkreuzung.",
    source: "Klassische Trendfolge (z. B. Murphy, Technical Analysis of the Financial Markets)",
    check: (p) => { if (p.fast >= p.slow) throw new Error("ma_crossover: fast muss kleiner als slow sein"); },
    entry: (df, p) => crossUp(ema(df.close, p.fast), ema(df.close, p.slow)),
    exit: (df, p) => lt(ema(df.close, p.fast), ema(df.close, p.slow)),
  },
  triple_ema: {
    defaultRegimes: T, paramSpec: { fast: ["int", 3, 30], mid: ["int", 10, 80], slow: ["int", 30, 250] },
    description: "Drei EMAs ordnen sich bullisch (schnell > mittel > langsam); Ausstieg, wenn schnell < mittel.",
    source: "Trendfolge mit EMA-Ausrichtung (u. a. Elder, Triple Screen)",
    check: (p) => { if (!(p.fast < p.mid && p.mid < p.slow)) throw new Error("triple_ema: fast < mid < slow erforderlich"); },
    entry(df, p) {
      const a = ema(df.close, p.fast), b = ema(df.close, p.mid), d = ema(df.close, p.slow);
      const al = a.map((v, i) => v > b[i] && b[i] > d[i]);
      return al.map((v, i) => v && !(i > 0 && al[i - 1]));
    },
    exit: (df, p) => lt(ema(df.close, p.fast), ema(df.close, p.mid)),
  },
  macd_cross: {
    defaultRegimes: T, paramSpec: { fast: ["int", 5, 20], slow: ["int", 15, 50], signal: ["int", 5, 15] },
    description: "MACD kreuzt seine Signallinie nach oben; Ausstieg bei Gegenkreuzung.", source: "Gerald Appel (1970er), MACD",
    check: (p) => { if (p.fast >= p.slow) throw new Error("macd_cross: fast muss kleiner als slow sein"); },
    entry: (df, p) => { const m = macdLine(df.close, p.fast, p.slow); return crossUp(m, ema(m, p.signal)); },
    exit: (df, p) => { const m = macdLine(df.close, p.fast, p.slow); return lt(m, ema(m, p.signal)); },
  },
  macd_zero: {
    defaultRegimes: T, paramSpec: { fast: ["int", 5, 20], slow: ["int", 15, 50] },
    description: "MACD-Linie kreuzt die Nulllinie nach oben; Ausstieg unter null.", source: "Gerald Appel, MACD-Nulllinie",
    check: (p) => { if (p.fast >= p.slow) throw new Error("macd_zero: fast muss kleiner als slow sein"); },
    entry: (df, p) => { const m = macdLine(df.close, p.fast, p.slow); return m.map((v, i) => v > 0 && i > 0 && m[i - 1] <= 0); },
    exit: (df, p) => lt(macdLine(df.close, p.fast, p.slow), 0),
  },
  adx_di: {
    defaultRegimes: T, paramSpec: { period: ["int", 7, 30], threshold: ["float", 15, 40] },
    description: "+DI kreuzt -DI nach oben bei starkem Trend (ADX über Schwelle); Ausstieg, wenn -DI > +DI.",
    source: "J. Welles Wilder, New Concepts in Technical Trading Systems (1978)",
    entry: (df, p) => { const d = dmi(df, p.period); return and(crossUp(d.plus, d.minus), gt(d.adx, p.threshold)); },
    exit: (df, p) => { const d = dmi(df, p.period); return gt(d.minus, d.plus); },
  },
  supertrend: {
    defaultRegimes: T, paramSpec: { period: ["int", 7, 30], mult: ["float", 1.0, 5.0] },
    description: "Supertrend (ATR-Band) dreht auf aufwärts; Ausstieg, wenn er auf abwärts dreht.", source: "Olivier Seban, Supertrend-Indikator",
    entry: (df, p) => { const d = supertrendDirection(df, p.period, p.mult); return d.map((v, i) => v === 1 && i > 0 && d[i - 1] === -1); },
    exit: (df, p) => supertrendDirection(df, p.period, p.mult).map((v) => v === -1),
  },
  parabolic_sar: {
    defaultRegimes: T, paramSpec: { step: ["float", 0.01, 0.05], max_af: ["float", 0.1, 0.4] },
    description: "Parabolic SAR wechselt unter den Kurs (Aufwärtstrend); Ausstieg beim Wechsel darüber.", source: "J. Welles Wilder (1978)",
    entry: (df, p) => { const d = psarDirection(df, p.step, p.max_af); return d.map((v, i) => v === 1 && i > 0 && d[i - 1] === -1); },
    exit: (df, p) => psarDirection(df, p.step, p.max_af).map((v) => v === -1),
  },
  ichimoku: {
    defaultRegimes: T, paramSpec: { tenkan: ["int", 5, 20], kijun: ["int", 20, 60], senkou_b: ["int", 40, 120] },
    description: "Tenkan kreuzt Kijun nach oben, Kurs über der Wolke; Ausstieg, wenn Tenkan < Kijun.", source: "Goichi Hosoda, Ichimoku Kinko Hyo",
    check: (p) => { if (!(p.tenkan < p.kijun && p.kijun < p.senkou_b)) throw new Error("ichimoku: tenkan < kijun < senkou_b erforderlich"); },
    entry: (df, p) => { const { t, k, top } = ichimokuLines(df, p); return and(crossUp(t, k), gt(df.close, top)); },
    exit: (df, p) => { const { t, k } = ichimokuLines(df, p); return lt(t, k); },
  },
  heikin_ashi: {
    defaultRegimes: T, paramSpec: { bars: ["int", 1, 5] },
    description: "N bullische Heikin-Ashi-Kerzen in Folge; Ausstieg bei der ersten bärischen.", source: "Heikin-Ashi (japanische Kerzentechnik), u. a. Dan Valcu",
    entry(df, p) {
      const bull = heikinBull(df), out = [];
      let streak = 0;
      for (let i = 0; i < bull.length; i++) { streak = bull[i] ? streak + 1 : 0; out.push(streak === p.bars); }
      return out;
    },
    exit: (df) => heikinBull(df).map((b) => !b),
  },
  roc_momentum: {
    defaultRegimes: T, paramSpec: { period: ["int", 5, 50], threshold: ["float", 0.0, 5.0] },
    description: "Kursänderung über N Kerzen (Rate of Change) steigt über eine Schwelle; Ausstieg, wenn sie negativ wird.",
    source: "Momentum-/ROC-Strategie (u. a. Jegadeesh & Titman zu Momentum)",
    entry: (df, p) => { const r = roc(df.close, p.period); return r.map((v, i) => v > p.threshold && i > 0 && r[i - 1] <= p.threshold); },
    exit: (df, p) => lt(roc(df.close, p.period), 0),
  },
  breakout: {
    defaultRegimes: T, paramSpec: { lookback: ["int", 10, 200], exit_lookback: ["int", 5, 100] },
    description: "Ausbruch über das Hoch der letzten N Kerzen; Ausstieg unter dem Tief der letzten M Kerzen (Donchian).",
    source: "Richard Donchian / Turtle-Trader (Dennis & Eckhardt)",
    check: (p) => { if (p.exit_lookback > p.lookback) throw new Error("breakout: exit_lookback darf lookback nicht überschreiten"); },
    entry: (df, p) => gt(df.close, shift(rollMax(df.high, p.lookback))),
    exit: (df, p) => lt(df.close, shift(rollMin(df.low, p.exit_lookback))),
  },
  squeeze_breakout: {
    defaultRegimes: TS, paramSpec: { period: ["int", 10, 40], bb_mult: ["float", 1.5, 3.0], kc_mult: ["float", 1.0, 2.5] },
    description: "Bollinger-Bänder lagen innerhalb der Keltner-Kanäle (Squeeze) und öffnen sich mit Kurs über der Mitte.",
    source: "John Carter, TTM Squeeze (Mastering the Trade)",
    entry(df, p) {
      const c = df.close, mid = sma(c, p.period), sd = rollStd(c, p.period), km = ema(c, p.period), a = atr(df, p.period);
      const on = c.map((_, i) => mid[i] + p.bb_mult * sd[i] < km[i] + p.kc_mult * a[i] && mid[i] - p.bb_mult * sd[i] > km[i] - p.kc_mult * a[i]);
      return on.map((v, i) => i > 0 && on[i - 1] && !v && c[i] > mid[i]);
    },
    exit: (df, p) => lt(df.close, ema(df.close, p.period)),
  },
  inside_bar: {
    defaultRegimes: T, paramSpec: { exit_ma: ["int", 5, 50] },
    description: "Nach einer Innenstab-Kerze schließt der Kurs über dem Hoch der Mutterkerze; Ausstieg unter der EMA.",
    source: "Price-Action-Muster Inside Bar (u. a. Al Brooks)",
    entry: (df) => df.close.map((c, i) => i >= 2 && df.high[i - 1] < df.high[i - 2] && df.low[i - 1] > df.low[i - 2] && c > df.high[i - 2]),
    exit: (df, p) => lt(df.close, ema(df.close, p.exit_ma)),
  },
  session_breakout: {
    defaultRegimes: ALL, paramSpec: { start_hour: ["int", 0, 20], range_hours: ["int", 1, 8], exit_hour: ["int", 2, 23] },
    description: "Spanne der ersten Handelsstunden (UTC) – Kauf beim ersten Ausbruch darüber, Ausstieg zur Schlussstunde oder unter der Spanne (z. B. London-Breakout).",
    source: "Opening-Range-/London-Breakout (u. a. Toby Crabel, Day Trading with Short Term Price Patterns)",
    check: (p) => { if (p.start_hour + p.range_hours >= p.exit_hour) throw new Error("session_breakout: start_hour + range_hours muss vor exit_hour liegen"); },
    entry: (df, p) => sessionSignals(df, p).entry,
    exit: (df, p) => sessionSignals(df, p).exit,
  },
  rsi_reversion: {
    defaultRegimes: S, paramSpec: { period: ["int", 5, 30], oversold: ["float", 10, 40], exit_level: ["float", 45, 80] },
    description: "Kauf bei überverkauftem RSI, Verkauf bei Erholung.", source: "J. Welles Wilder, RSI (1978)",
    entry: (df, p) => lt(rsi(df.close, p.period), p.oversold),
    exit: (df, p) => gt(rsi(df.close, p.period), p.exit_level),
  },
  connors_rsi2: {
    defaultRegimes: TS, paramSpec: { trend: ["int", 50, 300], rsi_period: ["int", 2, 5], oversold: ["float", 2, 20], exit_ma: ["int", 3, 20] },
    description: "Kurs über dem langen SMA (Trendfilter) und sehr kurzer RSI stark überverkauft; Ausstieg über kurzem SMA.",
    source: "Larry Connors & Cesar Alvarez, Short Term Trading Strategies That Work (2008)",
    entry: (df, p) => and(gt(df.close, sma(df.close, p.trend)), lt(rsi(df.close, p.rsi_period), p.oversold)),
    exit: (df, p) => gt(df.close, sma(df.close, p.exit_ma)),
  },
  ibs_reversion: {
    defaultRegimes: TS, paramSpec: { low: ["float", 0.05, 0.4], high: ["float", 0.6, 0.95] },
    description: "Internal Bar Strength: Schluss nahe am Kerzentief -> Kauf; Schluss nahe am Hoch -> Verkauf.",
    source: "IBS-Effekt (u. a. Pagonidis, 'The IBS Effect', NAAIM)",
    entry: (df, p) => df.close.map((c, i) => (c - df.low[i]) / (df.high[i] - df.low[i]) < p.low),
    exit: (df, p) => df.close.map((c, i) => (c - df.low[i]) / (df.high[i] - df.low[i]) > p.high),
  },
  bollinger_reversion: {
    defaultRegimes: S, paramSpec: { period: ["int", 10, 50], num_std: ["float", 1.0, 3.5] },
    description: "Kauf unter dem unteren Bollinger-Band, Ausstieg an der Mittellinie.", source: "John Bollinger, Bollinger on Bollinger Bands (2001)",
    entry: (df, p) => lt(df.close, bollinger(df.close, p.period, p.num_std).lower),
    exit: (df, p) => { const { mid } = bollinger(df.close, p.period, p.num_std); return df.close.map((c, i) => c >= mid[i]); },
  },
  keltner_reversion: {
    defaultRegimes: S, paramSpec: { period: ["int", 10, 50], mult: ["float", 1.0, 4.0] },
    description: "Kauf unter dem unteren Keltner-Kanal (EMA - x * ATR), Ausstieg an der EMA.", source: "Chester Keltner (1960) / Linda Raschke (ATR-Variante)",
    entry: (df, p) => { const m = ema(df.close, p.period), a = atr(df, p.period); return df.close.map((c, i) => c < m[i] - p.mult * a[i]); },
    exit: (df, p) => gt(df.close, ema(df.close, p.period)),
  },
  zscore_reversion: {
    defaultRegimes: S, paramSpec: { period: ["int", 10, 100], entry_z: ["float", 1.0, 3.5], exit_z: ["float", -1.0, 1.0] },
    description: "Kurs liegt mehr als X Standardabweichungen unter dem Mittelwert; Ausstieg bei Rückkehr.",
    source: "Statistische Mean Reversion (z. B. Chan, Algorithmic Trading, 2013)",
    entry: (df, p) => lt(zscore(df.close, p.period), -p.entry_z),
    exit: (df, p) => gt(zscore(df.close, p.period), p.exit_z),
  },
  williams_r: {
    defaultRegimes: S, paramSpec: { period: ["int", 5, 30], oversold: ["float", 70, 98], exit_level: ["float", 10, 60] },
    description: "Williams %R unter -oversold -> Kauf; über -exit_level -> Verkauf.", source: "Larry Williams, Williams %R (1973)",
    entry: (df, p) => lt(williams(df, p.period), -p.oversold),
    exit: (df, p) => gt(williams(df, p.period), -p.exit_level),
  },
  stochastic: {
    defaultRegimes: S, paramSpec: { k: ["int", 5, 30], d: ["int", 2, 10], oversold: ["float", 10, 35], overbought: ["float", 60, 90] },
    description: "%K kreuzt %D nach oben im überverkauften Bereich; Ausstieg im überkauften Bereich.", source: "George Lane, Stochastik-Oszillator (1950er)",
    entry: (df, p) => { const { k, d } = stochKD(df, p); return and(crossUp(k, d), lt(k, p.oversold)); },
    exit: (df, p) => gt(stochKD(df, p).k, p.overbought),
  },
  cci_reversion: {
    defaultRegimes: S, paramSpec: { period: ["int", 10, 40], level: ["float", 80, 250], exit_level: ["float", -50, 100] },
    description: "Commodity Channel Index unter -level -> Kauf; über exit_level -> Verkauf.", source: "Donald Lambert, CCI (1980)",
    entry: (df, p) => lt(cci(df, p.period), -p.level),
    exit: (df, p) => gt(cci(df, p.period), p.exit_level),
  },
  range_support: {
    defaultRegimes: S, paramSpec: { lookback: ["int", 20, 200], zone: ["float", 0.05, 0.5], min_range_pct: ["float", 0.2, 10.0], exit_frac: ["float", 0.4, 1.0] },
    description: "Range-Trading: Kauf, wenn der Kurs die Unterstützung (Tief der letzten N Kerzen) berührt und eine bullische Kerze schließt; Ausstieg in der Nähe des Widerstands (Hoch der letzten N Kerzen).",
    source: "Unterstützungs-/Widerstandshandel, Range Trading (trading.de, Technische Analyse nach Murphy)",
    check: (p) => { if (p.exit_frac <= p.zone) throw new Error("range_support: exit_frac muss größer als zone sein"); },
    entry(df, p) {
      const sup = shift(rollMin(df.low, p.lookback)), res = shift(rollMax(df.high, p.lookback));
      return df.close.map((c, i) => { const w = res[i] - sup[i]; return (w / c) * 100 >= p.min_range_pct && df.low[i] <= sup[i] + p.zone * w && c > df.open[i] && c >= sup[i]; });
    },
    exit(df, p) {
      const sup = shift(rollMin(df.low, p.lookback)), res = shift(rollMax(df.high, p.lookback));
      return df.close.map((c, i) => c >= sup[i] + p.exit_frac * (res[i] - sup[i]));
    },
  },
  vwap_reversion: {
    defaultRegimes: S, paramSpec: { period: ["int", 20, 200], deviation: ["float", 0.2, 5.0] },
    description: "Kurs liegt X % unter dem gleitenden VWAP -> Kauf; Ausstieg bei Rückkehr zum VWAP (braucht Volumen).",
    source: "VWAP-Reversion (institutionelle Ausführung, u. a. Berkowitz et al. 1988)",
    entry: (df, p) => { const v = vwap(df, p.period); return df.close.map((c, i) => c < v[i] * (1 - p.deviation / 100)); },
    exit: (df, p) => { const v = vwap(df, p.period); return df.close.map((c, i) => c >= v[i]); },
  },
  trend_pullback: {
    defaultRegimes: T, paramSpec: { trend: ["int", 50, 300], down_bars: ["int", 2, 6], exit_ma: ["int", 3, 20] },
    description: "Im Aufwärtstrend (Kurs über langer EMA) nach N fallenden Schlusskursen kaufen; Ausstieg über kurzem SMA.",
    source: "Buy-the-Dip im Trend (u. a. Connors, 'Multiple Days Down')",
    entry(df, p) {
      const c = df.close, down = c.map((v, i) => (i > 0 && v < c[i - 1] ? 1 : 0)), cnt = rollSum(down, p.down_bars), e = ema(c, p.trend);
      return c.map((v, i) => v > e[i] && cnt[i] === p.down_bars);
    },
    exit: (df, p) => gt(df.close, sma(df.close, p.exit_ma)),
  },
};
for (const def of Object.values(STRATEGY_TYPES)) def.check ||= () => {};

function validate(type, raw, spec) {
  const out = {};
  for (const [k, [typ, lo, hi]] of Object.entries(spec)) {
    const v = typ === "int" ? Math.trunc(Number(raw[k])) : Number(raw[k]);
    if (!Number.isFinite(v)) throw new Error(`${type}.${k}: ungültiger Wert ${JSON.stringify(raw[k])}`);
    if (v < lo || v > hi) throw new Error(`${type}.${k}=${v} außerhalb [${lo}, ${hi}]`);
    out[k] = v;
  }
  return out;
}

// Erzeugt (und validiert) eine Strategie aus einer Spezifikation. Wirft bei ungültigen Werten.
export function buildStrategy(spec, types = STRATEGY_TYPES) {
  if (!spec || typeof spec !== "object") throw new Error("Strategie-Spezifikation muss ein Objekt sein");
  const def = typeof spec.type === "string" && Object.hasOwn(types, spec.type) ? types[spec.type] : null;
  if (!def) throw new Error(`Unbekannter Strategietyp ${JSON.stringify(spec.type)}; erlaubt: ${Object.keys(types).join(", ")}`);
  const raw = spec.params;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("'params' muss ein Objekt sein");
  const exitKeys = Object.keys(raw).filter((k) => k in EXIT_SPEC && raw[k] != null);
  const unknown = Object.keys(raw).filter((k) => !(k in def.paramSpec) && !(k in EXIT_SPEC));
  const missing = Object.keys(def.paramSpec).filter((k) => !(k in raw));
  if (unknown.length || missing.length) throw new Error(`${spec.type}: unbekannte Parameter [${unknown}], fehlend [${missing}]`);
  const params = validate(spec.type, raw, def.paramSpec);
  const exits = validate(spec.type, raw, Object.fromEntries(exitKeys.map((k) => [k, EXIT_SPEC[k]])));
  const regimes = spec.regimes && spec.regimes.length ? [...spec.regimes] : [...def.defaultRegimes];
  const bad = regimes.filter((r) => !REGIMES.includes(r));
  if (bad.length) throw new Error(`${spec.type}: ungültige Marktphasen ${bad}`);
  def.check(params);
  const all = { ...params, ...exits };
  const name = `${spec.type}(${Object.entries(all).map(([k, v]) => `${k}=${v}`).join(",")})`;
  return {
    type: spec.type, params, exits, regimes, name, description: def.description, source: def.source,
    stopMult: (fallback) => exits.stop_mult ?? fallback,
    rr: (fallback) => exits.rr ?? fallback,
    entry: (df) => def.entry(df, params), exit: (df) => def.exit(df, params),
    explain: () => `${name}: Einstiegssignal (${def.description})`,
    toSpec: () => ({ type: spec.type, params: { ...all }, regimes: [...regimes] }),
  };
}

// Gleiche Liste wie DEFAULT_SPECS in tradingbot/strategies.py.
export const DEFAULT_SPECS = [
  ["ma_crossover", { fast: 9, slow: 21 }], ["ma_crossover", { fast: 20, slow: 50 }],
  ["triple_ema", { fast: 8, mid: 21, slow: 55 }], ["macd_cross", { fast: 12, slow: 26, signal: 9 }], ["macd_zero", { fast: 12, slow: 26 }],
  ["adx_di", { period: 14, threshold: 25 }], ["supertrend", { period: 10, mult: 3.0 }], ["parabolic_sar", { step: 0.02, max_af: 0.2 }],
  ["ichimoku", { tenkan: 9, kijun: 26, senkou_b: 52 }], ["heikin_ashi", { bars: 2 }], ["roc_momentum", { period: 12, threshold: 1.0 }],
  ["breakout", { lookback: 20, exit_lookback: 10 }], ["breakout", { lookback: 55, exit_lookback: 20 }],
  ["squeeze_breakout", { period: 20, bb_mult: 2.0, kc_mult: 1.5 }], ["inside_bar", { exit_ma: 20 }],
  ["session_breakout", { start_hour: 7, range_hours: 1, exit_hour: 16 }],
  ["rsi_reversion", { period: 14, oversold: 30, exit_level: 55 }], ["rsi_reversion", { period: 7, oversold: 20, exit_level: 50 }],
  ["connors_rsi2", { trend: 200, rsi_period: 2, oversold: 10, exit_ma: 5 }],
  ["connors_rsi2", { trend: 200, rsi_period: 2, oversold: 5, exit_ma: 5, stop_mult: 3.0, rr: 1.0 }],
  ["ibs_reversion", { low: 0.2, high: 0.8 }], ["ibs_reversion", { low: 0.1, high: 0.7, rr: 1.0 }],
  ["bollinger_reversion", { period: 20, num_std: 2.0 }], ["bollinger_reversion", { period: 20, num_std: 2.5, stop_mult: 3.0, rr: 1.0 }],
  ["keltner_reversion", { period: 20, mult: 2.0 }],
  ["zscore_reversion", { period: 50, entry_z: 2.0, exit_z: 0.0 }], ["zscore_reversion", { period: 30, entry_z: 2.5, exit_z: -0.5, rr: 1.0 }],
  ["williams_r", { period: 14, oversold: 90, exit_level: 30 }], ["stochastic", { k: 14, d: 3, oversold: 20, overbought: 80 }],
  ["cci_reversion", { period: 20, level: 150, exit_level: 0 }], ["range_support", { lookback: 48, zone: 0.25, min_range_pct: 1.0, exit_frac: 0.8 }], ["vwap_reversion", { period: 96, deviation: 1.0 }],
  ["trend_pullback", { trend: 200, down_bars: 3, exit_ma: 5 }], ["trend_pullback", { trend: 100, down_bars: 4, exit_ma: 5, rr: 1.0 }],
];

// PLAYBOOK: fünf feste Strategien, abgeleitet aus „Die 10 besten Trading Strategien“ (trading.de/lernen/strategien).
// Nur was sich als eindeutige Kursregel umsetzen lässt (News, Gap, Carry Trade und Smart Money Concepts nicht; Daytrading,
// Scalping und Swing sind Handelsstile, keine Regeln). Die Marktphase entscheidet, welche davon gerade „passt“.
export const PLAYBOOK = [
  { title: "Trendkanal-Ausbruch", type: "breakout", params: { lookback: 55, exit_lookback: 20 }, idea: "Trend-/Trendkanal-Trading: Kauf beim Ausbruch aus dem Kanal der letzten 55 Kerzen" },
  { title: "Pullback im Trend (Swing)", type: "trend_pullback", params: { trend: 100, down_bars: 3, exit_ma: 5 }, idea: "Swing Trading: im Aufwärtstrend nach einem Rücksetzer kaufen" },
  { title: "Price Action: Inside Bar", type: "inside_bar", params: { exit_ma: 20 }, idea: "Price Action: Kauf, wenn der Kurs aus einer Innenstab-Kerze nach oben ausbricht" },
  { title: "Range: Unterstützung kaufen", type: "range_support", params: { lookback: 48, zone: 0.25, min_range_pct: 1.0, exit_frac: 0.8 }, idea: "Unterstützungs-/Widerstandshandel: in der Seitwärtsphase an der Unterstützung kaufen" },
  { title: "Mean Reversion: Bollinger", type: "bollinger_reversion", params: { period: 20, num_std: 2.0 }, idea: "Mean Reversion: Kauf unter dem unteren Bollinger-Band, Ausstieg an der Mitte" },
];

export function playbookCandidates() {
  return PLAYBOOK.map(({ title, type, params, idea }) => ({ ...buildStrategy({ type, params }).toSpec(), source: "playbook", title, rationale: idea }));
}

// WINRATE5: fünf Varianten mit Trefferquote >= 55 % in einem Testlauf auf echten EUR/USD-Kerzen (15m, 2017/18). Nur ZWEI davon
// (trend_pullback, stochastic) waren dort auch im Plus; die anderen drei hatten hohe Trefferquote bei negativer Rendite.
export const WINRATE5 = [
  { title: "Pullback im Trend (68 % Treffer)", type: "trend_pullback", params: { trend: 100, down_bars: 4, exit_ma: 5, rr: 1.0 }, idea: "Testlauf EUR/USD: Trefferquote 68,1 %, Rendite +1,5 %" },
  { title: "Stochastik (56 % Treffer)", type: "stochastic", params: { k: 14, d: 3, oversold: 20, overbought: 80 }, idea: "Testlauf EUR/USD: Trefferquote 55,8 %, Rendite +0,6 %" },
  { title: "Connors RSI(2) (62 % Treffer)", type: "connors_rsi2", params: { trend: 200, rsi_period: 2, oversold: 10, exit_ma: 5 }, idea: "Testlauf EUR/USD: Trefferquote 62,1 %, aber Rendite -3,3 %" },
  { title: "Z-Score-Rückkehr (58 % Treffer)", type: "zscore_reversion", params: { period: 30, entry_z: 2.5, exit_z: -0.5, rr: 1.0 }, idea: "Testlauf EUR/USD: Trefferquote 58,4 %, aber Rendite -2,7 %" },
  { title: "Bollinger-Rückkehr (58 % Treffer)", type: "bollinger_reversion", params: { period: 20, num_std: 2.5, stop_mult: 3.0, rr: 1.0 }, idea: "Testlauf EUR/USD: Trefferquote 58,4 %, aber Rendite -4,8 %" },
];

export function fixedCandidates(profile) {
  const list = profile === "winrate" ? WINRATE5 : PLAYBOOK;
  return list.map(({ title, type, params, idea }) => ({ ...buildStrategy({ type, params }).toSpec(), source: profile, title, rationale: idea }));
}

export function defaultCandidates() {
  return DEFAULT_SPECS.map(([type, params]) => {
    const s = buildStrategy({ type, params });
    return { ...s.toSpec(), source: "builtin", rationale: `${s.description} Quelle: ${s.source}` };
  });
}

export function describeParamBounds() {
  const lines = Object.entries(STRATEGY_TYPES).map(([name, d]) => {
    const b = Object.entries(d.paramSpec).map(([k, [t, lo, hi]]) => `${k}: ${t} in [${lo}, ${hi}]`).join(", ");
    return `- "${name}": ${d.description} Parameter: ${b}. Standard-Marktphasen: ${JSON.stringify(d.defaultRegimes)}`;
  });
  const opt = Object.entries(EXIT_SPEC).map(([k, [t, lo, hi]]) => `${k}: ${t} in [${lo}, ${hi}]`).join(", ");
  lines.push(`Optional für jede Strategie: ${opt} (stop_mult = Stop in ATR, rr = Ziel als Vielfaches des Risikos).`);
  return lines.join("\n");
}
