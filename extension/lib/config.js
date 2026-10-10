// Standard-Konfiguration (entspricht config.solana.yaml des Python-Bots) und Validierung.
import { timeframeSeconds } from "./util.js";

export const DEFAULTS = {
  liveTrading: false, // Paper-Modus ist Standard
  timeframe: "15m", // 5m | 15m | 30m | 1h
  capital: { start: 300 }, // Paper: Startguthaben. Live: maximal eingesetztes USDC
  risk: {
    riskPerTradePct: 1.0, maxDailyLossPct: 5.0, closePositionsOnDailyLimit: true,
    maxOpenPositions: 1, maxPositionPct: 50.0, atrPeriod: 14, atrStopMult: 2.0, takeProfitRr: 2.0,
  },
  costs: { feePct: 0.10, slippagePct: 0.15 },
  backtest: {
    minCandles: 1000, minTrades: 20, minReturnPct: 2.0, maxDrawdownPct: 15.0, minSharpe: 1.0,
    minWinRatePct: 35.0, minProfitFactor: 1.2, oosFraction: 0.3, minOosReturnPct: 0.0,
  },
  pipeline: { revalidateHours: 24, historyCandles: 3000 },
  solana: {
    rpcUrl: "https://api.mainnet-beta.solana.com",
    jupiterUrl: "https://lite-api.jup.ag/swap/v1",
    usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    solReserve: 0.05, slippageBps: 50, maxPriceImpactPct: 0.5, maxDeviationPct: 1.0, priorityFeeLamports: 50000,
  },
  llm: { enabled: false, model: "claude-sonnet-5-5", apiKey: "", maxTokens: 4000 },
  telegram: { enabled: false, token: "", chatId: "" },
};

export const ALLOWED_TIMEFRAMES = ["5m", "15m", "30m", "1h"];

export function mergeConfig(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (!(k in base)) continue; // unbekannte Schlüssel ignorieren
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? mergeConfig(base[k], v) : v;
  }
  return out;
}

export function validateConfig(c) {
  const fail = (msg) => { throw new Error(msg); };
  if (typeof c.liveTrading !== "boolean") fail("liveTrading muss true/false sein.");
  if (!ALLOWED_TIMEFRAMES.includes(c.timeframe)) fail(`Zeitrahmen muss einer von ${ALLOWED_TIMEFRAMES.join(", ")} sein.`);
  timeframeSeconds(c.timeframe);
  if (!(c.capital.start > 0)) fail("Startkapital muss > 0 sein.");
  const r = c.risk;
  if (!(r.riskPerTradePct > 0 && r.riskPerTradePct <= 2)) fail("Risiko pro Trade muss in (0, 2] % liegen.");
  if (!(r.maxDailyLossPct > 0 && r.maxDailyLossPct <= 100)) fail("Max. Tagesverlust muss in (0, 100] % liegen.");
  if (!(r.maxOpenPositions >= 1)) fail("Max. offene Positionen muss >= 1 sein.");
  if (!(r.maxPositionPct > 0 && r.maxPositionPct <= 100)) fail("Max. Positionsgröße muss in (0, 100] % liegen.");
  if (!(r.atrPeriod >= 2 && r.atrStopMult > 0 && r.takeProfitRr > 0)) fail("ATR-/Stop-Parameter ungültig.");
  if (c.costs.feePct < 0 || c.costs.slippagePct < 0) fail("Kosten dürfen nicht negativ sein.");
  if (!(c.backtest.oosFraction > 0 && c.backtest.oosFraction < 1)) fail("oosFraction muss in (0, 1) liegen.");
  if (!(c.solana.solReserve >= 0 && c.solana.slippageBps >= 1)) fail("Solana-Parameter ungültig.");
  if (!/^https:\/\//.test(c.solana.rpcUrl) || !/^https:\/\//.test(c.solana.jupiterUrl)) fail("RPC- und Jupiter-URL müssen mit https:// beginnen.");
  return c;
}
