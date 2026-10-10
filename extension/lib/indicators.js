// Marktanalyse: Indikatoren und Marktzustand (1:1-Port von tradingbot/analysis.py).
// Kerzendaten ("df"): { t: [ms], open: [], high: [], low: [], close: [], volume: [] }

export const REGIMES = ["uptrend", "downtrend", "sideways"];
export const MIN_CANDLES = 150;
const ADX_TREND = 22.0, EMA_FAST = 20, EMA_SLOW = 50, ADX_PERIOD = 14;

const nan = () => NaN;

export function ema(x, n) {
  const a = 2 / (n + 1), out = new Array(x.length).fill(NaN);
  let prev = NaN;
  for (let i = 0; i < x.length; i++) {
    if (Number.isNaN(x[i])) { out[i] = prev; continue; }
    prev = Number.isNaN(prev) ? x[i] : a * x[i] + (1 - a) * prev;
    out[i] = prev;
  }
  return out;
}

// pandas ewm(alpha=1/n, adjust=False, min_periods=n)
export function wilder(x, n) {
  const a = 1 / n, out = new Array(x.length).fill(NaN);
  let prev = NaN, count = 0;
  for (let i = 0; i < x.length; i++) {
    if (!Number.isNaN(x[i])) {
      prev = Number.isNaN(prev) ? x[i] : a * x[i] + (1 - a) * prev;
      count++;
    }
    out[i] = count >= n ? prev : NaN;
  }
  return out;
}

export function rsi(close, n = 14) {
  const gain = [NaN], loss = [NaN];
  for (let i = 1; i < close.length; i++) {
    const d = close[i] - close[i - 1];
    gain.push(d > 0 ? d : 0);
    loss.push(d < 0 ? -d : 0);
  }
  const g = wilder(gain, n), l = wilder(loss, n);
  return g.map((gv, i) => (Number.isNaN(l[i]) ? NaN : l[i] === 0 ? 100 : 100 - 100 / (1 + gv / l[i])));
}

export function trueRange(df) {
  return df.close.map((_, i) => {
    const hl = df.high[i] - df.low[i];
    if (i === 0) return hl;
    const pc = df.close[i - 1];
    return Math.max(hl, Math.abs(df.high[i] - pc), Math.abs(df.low[i] - pc));
  });
}

export const atr = (df, n = 14) => wilder(trueRange(df), n);

export function rolling(x, n, fn) {
  const out = new Array(x.length).fill(NaN);
  for (let i = n - 1; i < x.length; i++) {
    const w = x.slice(i - n + 1, i + 1);
    if (w.some(Number.isNaN)) continue;
    out[i] = fn(w);
  }
  return out;
}
const mean = (w) => w.reduce((a, b) => a + b, 0) / w.length;
export const rollMean = (x, n) => rolling(x, n, mean);
export const rollMax = (x, n) => rolling(x, n, (w) => Math.max(...w));
export const rollMin = (x, n) => rolling(x, n, (w) => Math.min(...w));
export const rollStd = (x, n) => rolling(x, n, (w) => { const m = mean(w); return Math.sqrt(mean(w.map((v) => (v - m) ** 2))); });
export const shift = (x, k = 1) => x.map((_, i) => (i - k >= 0 ? x[i - k] : NaN));

export function bollinger(close, n = 20, k = 2.0) {
  const mid = rollMean(close, n), sd = rollStd(close, n);
  return { lower: mid.map((m, i) => m - k * sd[i]), mid, upper: mid.map((m, i) => m + k * sd[i]) };
}

// Directional Movement (Wilder): +DI, -DI und ADX
export function dmi(df, n = 14) {
  const len = df.close.length, pdm = new Array(len).fill(0), mdm = new Array(len).fill(0);
  for (let i = 1; i < len; i++) {
    const up = df.high[i] - df.high[i - 1], down = -(df.low[i] - df.low[i - 1]);
    if (up > down && up > 0) pdm[i] = up;
    if (down > up && down > 0) mdm[i] = down;
  }
  const a = atr(df, n), pw = wilder(pdm, n), mw = wilder(mdm, n);
  const plus = pw.map((v, i) => (100 * v) / a[i]), minus = mw.map((v, i) => (100 * v) / a[i]);
  const dx = plus.map((p, i) => { const s = p + minus[i]; return s === 0 ? NaN : (100 * Math.abs(p - minus[i])) / s; });
  return { plus, minus, adx: wilder(dx, n) };
}

export const adx = (df, n = 14) => dmi(df, n).adx;

export const rollSum = (x, n) => rolling(x, n, (w) => w.reduce((a, b) => a + b, 0));

export function regimeSeries(df) {
  const fast = ema(df.close, EMA_FAST), slow = ema(df.close, EMA_SLOW), s = adx(df, ADX_PERIOD);
  return df.close.map((c, i) => {
    if (s[i] >= ADX_TREND && fast[i] > slow[i] && c > slow[i]) return "uptrend";
    if (s[i] >= ADX_TREND && fast[i] < slow[i] && c < slow[i]) return "downtrend";
    return "sideways";
  });
}

const level = (ratio, low, high) => (!Number.isFinite(ratio) ? "normal" : ratio > high ? "high" : ratio < low ? "low" : "normal");
const last = (x) => x[x.length - 1];

export function classifyMarket(df) {
  if (df.close.length < MIN_CANDLES) throw new Error(`Mindestens ${MIN_CANDLES} Kerzen nötig, erhalten: ${df.close.length}`);
  const a = atr(df, 14), atrPct = a.map((v, i) => (v / df.close[i]) * 100);
  const median = (w) => { const s = [...w].sort((p, q) => p - q), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const volRatio = last(atrPct) / last(rolling(atrPct, 100, median));
  const volAvg = last(rollMean(df.volume, 50));
  const voluRatio = volAvg ? last(rollMean(df.volume, 5)) / volAvg : NaN;
  return {
    regime: last(regimeSeries(df)),
    volatility: level(volRatio, 0.7, 1.5),
    volume: level(voluRatio, 0.6, 1.5),
    adx: last(adx(df, ADX_PERIOD)),
    atrPct: last(atrPct),
    emaFast: last(ema(df.close, EMA_FAST)),
    emaSlow: last(ema(df.close, EMA_SLOW)),
    close: last(df.close),
  };
}

export function summarize(s) {
  return `${s.regime} (ADX ${s.adx.toFixed(1)}, EMA${EMA_FAST} ${s.emaFast.toFixed(2)} vs EMA${EMA_SLOW} ${s.emaSlow.toFixed(2)}), ` +
    `Volatilität ${s.volatility} (ATR ${s.atrPct.toFixed(2)}%), Volumen ${s.volume}`;
}
