// Recherche -> Backtest -> Zulassung. Nur hier entstehen zugelassene Strategien.
import { classifyMarket } from "./indicators.js";
import { buildStrategy } from "./strategies.js";
import { checkThresholds, runBacktest } from "./backtest.js";
import { collectCandidates } from "./research.js";
import { fetchHistory } from "./data.js";

export async function researchAndBacktest(cfg, fetchFn = fetch, history = null) {
  const df = history || (await fetchHistory(cfg, cfg.pipeline.historyCandles, fetchFn));
  if (df.close.length < cfg.backtest.minCandles) {
    throw new Error(`Nur ${df.close.length} Kerzen (min. ${cfg.backtest.minCandles}) – keine Zulassung möglich`);
  }
  let state = null;
  try { state = classifyMarket(df); } catch { /* zu wenig Daten für den Kontext */ }
  const candidates = await collectCandidates(cfg, state, fetchFn);

  const approved = [], report = [];
  for (const spec of candidates) {
    let strategy;
    try { strategy = buildStrategy(spec); } catch (e) { console.warn("Kandidat übersprungen:", e.message); continue; }
    const result = runBacktest(cfg, df, strategy);
    const { ok, failures } = checkThresholds(result.metrics, cfg.backtest);
    report.push({ strategy: strategy.name, source: spec.source || "", approved: ok, failures, metrics: result.metrics });
    if (ok) {
      approved.push({ symbol: "SOL/USD", timeframe: cfg.timeframe, spec: strategy.toSpec(), name: strategy.name,
        source: spec.source || "", rationale: spec.rationale || "", metrics: result.metrics });
    }
  }
  return { approved, report, candles: df.close.length, generatedAt: new Date().toISOString() };
}

// Wählt unter den zugelassenen Strategien die mit dem höchsten Sharpe, die zur Marktphase passt.
export function selectStrategy(approved, timeframe, state) {
  let best = null;
  for (const rec of approved) {
    if (rec.timeframe !== timeframe) continue;
    let strategy;
    try { strategy = buildStrategy(rec.spec); } catch { continue; }
    if (!strategy.regimes.includes(state.regime)) continue;
    const score = (rec.metrics?.sharpe ?? 0) + 1e-6 * (rec.metrics?.return_pct ?? 0);
    if (!best || score > best.score) best = { strategy, record: rec, score };
  }
  return best;
}
