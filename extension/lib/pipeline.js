// Recherche -> Backtest -> Zulassung je Asset. Nur hier entstehen zugelassene Strategien.
import { classifyMarket } from "./indicators.js";
import { buildStrategy } from "./strategies.js";
import { checkThresholds, runBacktest } from "./backtest.js";
import { collectCandidates } from "./research.js";
import { fetchHistory } from "./data.js";
import { symbolOf } from "./config.js";

export async function researchAndBacktest(cfg, fetchFn = fetch, histories = null) {
  const frames = {}, problems = [];
  for (const base of cfg.assets) {
    const symbol = symbolOf(base);
    try {
      const df = histories?.[symbol] || (await fetchHistory(cfg, symbol, cfg.pipeline.historyCandles, fetchFn));
      if (df.close.length < cfg.backtest.minCandles) throw new Error(`nur ${df.close.length} Kerzen (min. ${cfg.backtest.minCandles})`);
      frames[symbol] = df;
    } catch (e) {
      problems.push(`${symbol}: ${e.message}`);
    }
  }
  if (!Object.keys(frames).length) throw new Error(`Keine ausreichende Historie – ${problems.join("; ")}`);

  const first = Object.keys(frames)[0];
  let state = null;
  try { state = classifyMarket(frames[first]); } catch { /* zu wenig Daten für den Kontext */ }
  const candidates = await collectCandidates(cfg, state, fetchFn);

  const approved = [], report = [];
  for (const spec of candidates) {
    let strategy;
    try { strategy = buildStrategy(spec); } catch (e) { console.warn("Kandidat übersprungen:", e.message); continue; }
    for (const [symbol, df] of Object.entries(frames)) {
      const result = runBacktest(cfg, df, strategy);
      const { ok, failures } = checkThresholds(result.metrics, cfg.backtest);
      report.push({ symbol, strategy: strategy.name, source: spec.source || "", approved: ok, failures, metrics: result.metrics });
      if (ok) {
        approved.push({ symbol, timeframe: cfg.timeframe, spec: strategy.toSpec(), name: strategy.name,
          source: spec.source || "", rationale: spec.rationale || "", metrics: result.metrics });
      }
    }
  }
  return { approved, report, problems, candles: Object.values(frames).map((f) => f.close.length), generatedAt: new Date().toISOString() };
}

// Wählt unter den zugelassenen Strategien des Symbols die mit dem höchsten Sharpe, die zur Marktphase passt.
export function selectStrategy(approved, symbol, timeframe, state) {
  let best = null;
  for (const rec of approved) {
    if (rec.symbol !== symbol || rec.timeframe !== timeframe) continue;
    let strategy;
    try { strategy = buildStrategy(rec.spec); } catch { continue; }
    if (!strategy.regimes.includes(state.regime)) continue;
    const score = (rec.metrics?.sharpe ?? 0) + 1e-6 * (rec.metrics?.return_pct ?? 0);
    if (!best || score > best.score) best = { strategy, record: rec, score };
  }
  return best;
}
