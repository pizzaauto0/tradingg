// Verständliche Namen statt technischer Strategie-Bezeichnungen ("range_support(lookback=48,zone=0.25,…)" → "Range-Unterstützung") und kurze Zeitangaben.
export const STRATEGY_NAMES = {
  ma_crossover: "EMA-Kreuzung", triple_ema: "Dreifach-EMA", macd_cross: "MACD-Kreuzung", macd_zero: "MACD-Nulllinie", adx_di: "ADX-Trend", supertrend: "Supertrend",
  parabolic_sar: "Parabolic SAR", ichimoku: "Ichimoku", heikin_ashi: "Heikin-Ashi", roc_momentum: "Momentum", breakout: "Ausbruch", squeeze_breakout: "Squeeze-Ausbruch",
  inside_bar: "Inside-Bar", session_breakout: "Sitzungs-Ausbruch", rsi_reversion: "RSI-Rückkehr", connors_rsi2: "Connors RSI(2)", ibs_reversion: "IBS-Rücksetzer",
  bollinger_reversion: "Bollinger-Rückkehr", keltner_reversion: "Keltner-Rückkehr", zscore_reversion: "Z-Score-Rückkehr", williams_r: "Williams %R", stochastic: "Stochastik",
  cci_reversion: "CCI-Rückkehr", range_support: "Range-Unterstützung", ma_pullback: "Linien-Rücksetzer", vwap_reversion: "VWAP-Rückkehr", trend_pullback: "Trend-Rücksetzer",
};

// "Test · breakout(lookback=55,…)" → "Test · Ausbruch"; "Manuell" bleibt; Unbekanntes bleibt unverändert (ohne Klammerteil)
export function strategyLabel(name) {
  if (!name) return "–";
  const s = String(name), test = s.startsWith("Test · ") ? "Test · " : "", core = s.replace(/^Test · /, "");
  const type = core.split("(")[0].trim();
  return test + (STRATEGY_NAMES[type] || type);
}

// Wie lange her: "vor 12 min", "vor 3 h 20 min", "vor 2 Tagen"
export function ago(iso, now = Date.now()) {
  const ms = Math.max(0, now - Date.parse(iso)), min = Math.round(ms / 60000);
  if (min < 1) return "gerade eben";
  if (min < 60) return `vor ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `vor ${h} h${min % 60 ? ` ${min % 60} min` : ""}`;
  const d = Math.floor(h / 24);
  return `vor ${d} ${d === 1 ? "Tag" : "Tagen"}`;
}

export const stamp = (iso) => new Date(iso).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
