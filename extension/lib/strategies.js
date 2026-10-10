// Strategie-Bausteine mit festen, validierten Parametern (Port von tradingbot/strategies.py).
// Auch LLM-Vorschläge werden nur als Spezifikation {type, params, regimes} akzeptiert – es wird nie Code ausgeführt.
import { REGIMES, ema, rsi, bollinger, rollMax, rollMin, shift } from "./indicators.js";

const lastOf = (x) => x[x.length - 1];

export const STRATEGY_TYPES = {
  ma_crossover: {
    defaultRegimes: ["uptrend"],
    paramSpec: { fast: ["int", 3, 50], slow: ["int", 10, 200] },
    description: "Einstieg, wenn die schnelle EMA die langsame von unten kreuzt; Ausstieg bei Gegenkreuzung.",
    check: (p) => { if (p.fast >= p.slow) throw new Error("ma_crossover: fast muss kleiner als slow sein"); },
    entry(df, p) {
      const f = ema(df.close, p.fast), s = ema(df.close, p.slow), pf = shift(f), ps = shift(s);
      return f.map((v, i) => v > s[i] && pf[i] <= ps[i]);
    },
    exit(df, p) { const f = ema(df.close, p.fast), s = ema(df.close, p.slow); return f.map((v, i) => v < s[i]); },
    explain(df, p) {
      const f = ema(df.close, p.fast), s = ema(df.close, p.slow);
      return `EMA${p.fast} (${lastOf(f).toFixed(2)}) kreuzt EMA${p.slow} (${lastOf(s).toFixed(2)}) nach oben`;
    },
  },
  rsi_reversion: {
    defaultRegimes: ["sideways"],
    paramSpec: { period: ["int", 5, 30], oversold: ["float", 10, 40], exit_level: ["float", 45, 80] },
    description: "Kauf bei überverkauftem RSI, Verkauf bei Erholung (Mean Reversion).",
    check: () => {},
    entry: (df, p) => rsi(df.close, p.period).map((v) => v < p.oversold),
    exit: (df, p) => rsi(df.close, p.period).map((v) => v > p.exit_level),
    explain: (df, p) => `RSI(${p.period})=${lastOf(rsi(df.close, p.period)).toFixed(1)} unter Schwelle ${p.oversold}`,
  },
  breakout: {
    defaultRegimes: ["uptrend"],
    paramSpec: { lookback: ["int", 10, 200], exit_lookback: ["int", 5, 100] },
    description: "Einstieg bei Ausbruch über das Hoch der letzten N Kerzen; Ausstieg unter dem Tief der letzten M Kerzen.",
    check: (p) => { if (p.exit_lookback > p.lookback) throw new Error("breakout: exit_lookback darf lookback nicht überschreiten"); },
    entry(df, p) { const lv = shift(rollMax(df.high, p.lookback)); return df.close.map((c, i) => c > lv[i]); },
    exit(df, p) { const lv = shift(rollMin(df.low, p.exit_lookback)); return df.close.map((c, i) => c < lv[i]); },
    explain(df, p) {
      const lv = lastOf(shift(rollMax(df.high, p.lookback)));
      return `Schlusskurs ${lastOf(df.close).toFixed(2)} über ${p.lookback}-Kerzen-Hoch ${lv.toFixed(2)}`;
    },
  },
  bollinger_reversion: {
    defaultRegimes: ["sideways"],
    paramSpec: { period: ["int", 10, 50], num_std: ["float", 1.0, 3.5] },
    description: "Kauf unter dem unteren Bollinger-Band, Ausstieg an der Mittellinie.",
    check: () => {},
    entry(df, p) { const { lower } = bollinger(df.close, p.period, p.num_std); return df.close.map((c, i) => c < lower[i]); },
    exit(df, p) { const { mid } = bollinger(df.close, p.period, p.num_std); return df.close.map((c, i) => c >= mid[i]); },
    explain(df, p) {
      const { lower } = bollinger(df.close, p.period, p.num_std);
      return `Schlusskurs ${lastOf(df.close).toFixed(2)} unter unterem Band ${lastOf(lower).toFixed(2)}`;
    },
  },
};

// Erzeugt (und validiert) eine Strategie aus einer Spezifikation. Wirft bei ungültigen Werten.
export function buildStrategy(spec, types = STRATEGY_TYPES) {
  if (!spec || typeof spec !== "object") throw new Error("Strategie-Spezifikation muss ein Objekt sein");
  const def = Object.hasOwn(types, spec.type) ? types[spec.type] : null;
  if (!def) throw new Error(`Unbekannter Strategietyp ${JSON.stringify(spec.type)}; erlaubt: ${Object.keys(types).join(", ")}`);
  const raw = spec.params;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("'params' muss ein Objekt sein");
  const unknown = Object.keys(raw).filter((k) => !(k in def.paramSpec));
  const missing = Object.keys(def.paramSpec).filter((k) => !(k in raw));
  if (unknown.length || missing.length) throw new Error(`${spec.type}: unbekannte Parameter [${unknown}], fehlend [${missing}]`);
  const params = {};
  for (const [k, [typ, lo, hi]] of Object.entries(def.paramSpec)) {
    const v = typ === "int" ? Math.trunc(Number(raw[k])) : Number(raw[k]);
    if (!Number.isFinite(v)) throw new Error(`${spec.type}.${k}: ungültiger Wert ${JSON.stringify(raw[k])}`);
    if (v < lo || v > hi) throw new Error(`${spec.type}.${k}=${v} außerhalb [${lo}, ${hi}]`);
    params[k] = v;
  }
  const regimes = spec.regimes && spec.regimes.length ? [...spec.regimes] : [...def.defaultRegimes];
  const bad = regimes.filter((r) => !REGIMES.includes(r));
  if (bad.length) throw new Error(`${spec.type}: ungültige Marktphasen ${bad}`);
  def.check(params);
  const name = `${spec.type}(${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(",")})`;
  return {
    type: spec.type, params, regimes, name,
    entry: (df) => def.entry(df, params), exit: (df) => def.exit(df, params), explain: (df) => def.explain(df, params),
    toSpec: () => ({ type: spec.type, params: { ...params }, regimes: [...regimes] }),
  };
}

export function defaultCandidates() {
  const specs = [
    ["ma_crossover", { fast: 9, slow: 21 }], ["ma_crossover", { fast: 20, slow: 50 }], ["ma_crossover", { fast: 50, slow: 200 }],
    ["rsi_reversion", { period: 14, oversold: 30, exit_level: 55 }], ["rsi_reversion", { period: 14, oversold: 25, exit_level: 50 }],
    ["rsi_reversion", { period: 7, oversold: 20, exit_level: 50 }],
    ["breakout", { lookback: 20, exit_lookback: 10 }], ["breakout", { lookback: 55, exit_lookback: 20 }],
    ["bollinger_reversion", { period: 20, num_std: 2.0 }], ["bollinger_reversion", { period: 20, num_std: 2.5 }],
  ];
  return specs.map(([type, params]) => ({
    ...buildStrategy({ type, params }).toSpec(), source: "builtin", rationale: STRATEGY_TYPES[type].description,
  }));
}

export function describeParamBounds() {
  return Object.entries(STRATEGY_TYPES).map(([name, d]) => {
    const b = Object.entries(d.paramSpec).map(([k, [t, lo, hi]]) => `${k}: ${t} in [${lo}, ${hi}]`).join(", ");
    return `- "${name}": ${d.description} Parameter: ${b}. Standard-Marktphasen: ${JSON.stringify(d.defaultRegimes)}`;
  }).join("\n");
}
