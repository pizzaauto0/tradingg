// Standard-Konfiguration (entspricht config.solana.yaml des Python-Bots) und Validierung.
import { timeframeSeconds } from "./util.js";

// Handelbare Assets (nur liquide Majors, keine Memecoins). mint = Token-Adresse auf Solana; die Nachkommastellen werden
// zur Laufzeit per RPC gelesen. Die Adressen für BTC/ETH sind Wormhole-Wrapped-Token – bitte selbst gegen einen
// Solana-Explorer prüfen (in den Einstellungen überschreibbar). Falsche Adressen fängt der Preisabgleich gegen die Börsenkurse ab.
export const ASSETS = {
  SOL: { symbol: "SOL/USD", kraken: "SOLUSD", bitstamp: "solusd", mint: "So11111111111111111111111111111111111111112" },
  BTC: { symbol: "BTC/USD", kraken: "XBTUSD", bitstamp: "btcusd", mint: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh" },
  ETH: { symbol: "ETH/USD", kraken: "ETHUSD", bitstamp: "ethusd", mint: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs" },
};
export const symbolOf = (base) => ASSETS[base].symbol;
export const baseOf = (symbol) => symbol.split("/")[0];

export const DEFAULTS = {
  liveTrading: false, // Paper-Modus ist Standard
  assets: ["SOL", "BTC", "ETH"], // gleichzeitig beobachtete/gehandelte Märkte
  timeframe: "15m", // 5m | 15m | 30m | 1h
  capital: { start: 300 }, // Paper: Startguthaben. Live: maximal eingesetztes USDC
  risk: {
    riskPerTradePct: 1.0, maxDailyLossPct: 5.0, closePositionsOnDailyLimit: true,
    maxOpenPositions: 2, maxPositionPct: 50.0, atrPeriod: 14, atrStopMult: 2.0, takeProfitRr: 2.0,
  },
  costs: { feePct: 0.10, slippagePct: 0.15 },
  backtest: {
    minCandles: 1000, minTrades: 20, minReturnPct: 2.0, maxDrawdownPct: 15.0, minSharpe: 1.0,
    minWinRatePct: 55.0, minProfitFactor: 1.2, oosFraction: 0.3, minOosReturnPct: 0.0,
    profile: "strict", // strict (Standard) | explore (gelockert, NUR Paper: Strategien sind dann nicht bewiesen)
  },
  pipeline: { revalidateHours: 24, historyCandles: 3000, maxActiveStrategies: 5 },
  solana: {
    rpcUrl: "https://api.mainnet-beta.solana.com",
    jupiterUrl: "https://lite-api.jup.ag/swap/v1",
    usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    mints: {}, // optionale Überschreibung der Token-Adressen, z. B. { BTC: "…" }
    solReserve: 0.05, slippageBps: 50, maxPriceImpactPct: 0.5, maxDeviationPct: 1.0, priorityFeeLamports: 50000,
  },
  llm: { enabled: false, model: "claude-sonnet-5-5", apiKey: "", maxTokens: 4000 },
  telegram: { enabled: false, token: "", chatId: "" },
};

// Gelockerte Mindestwerte des Erkundungsmodus (nur Paper): zeigt Trades, beweist aber nichts.
export const EXPLORE_THRESHOLDS = { minTrades: 10, minReturnPct: 0, maxDrawdownPct: 25, minSharpe: 0, minWinRatePct: 45, minProfitFactor: 1.0, minOosReturnPct: -5 };
export const effectiveThresholds = (bt) => (bt.profile === "explore" ? { ...bt, ...EXPLORE_THRESHOLDS } : bt);

export const ALLOWED_TIMEFRAMES = ["5m", "15m", "30m", "1h"];

export function mergeConfig(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (!(k in base)) continue; // unbekannte Schlüssel ignorieren
    const open = base[k] && typeof base[k] === "object" && !Array.isArray(base[k]) && Object.keys(base[k]).length === 0;
    out[k] = v && typeof v === "object" && !Array.isArray(v) && !open ? mergeConfig(base[k], v) : v;
  }
  return out;
}

export function validateConfig(c) {
  const fail = (msg) => { throw new Error(msg); };
  if (typeof c.liveTrading !== "boolean") fail("liveTrading muss true/false sein.");
  if (!["strict", "explore"].includes(c.backtest.profile)) fail("Prüfmodus muss 'strict' oder 'explore' sein.");
  if (c.liveTrading && c.backtest.profile === "explore") fail("Der Erkundungsmodus (gelockerte Prüfung) ist nur im Paper-Modus erlaubt – für Live gilt immer 'strict'.");
  if (!Array.isArray(c.assets) || !c.assets.length || c.assets.some((a) => !Object.hasOwn(ASSETS, a))) {
    fail(`assets muss eine nicht leere Liste aus ${Object.keys(ASSETS).join(", ")} sein.`);
  }
  for (const [k, m] of Object.entries(c.solana.mints || {})) {
    if (!Object.hasOwn(ASSETS, k) || (m && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m))) fail(`Ungültige Token-Adresse für ${k}.`);
  }
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
  if (!(Number.isInteger(c.pipeline.maxActiveStrategies) && c.pipeline.maxActiveStrategies >= 1)) fail("Anzahl aktiver Strategien muss eine ganze Zahl >= 1 sein.");
  if (!(c.backtest.oosFraction > 0 && c.backtest.oosFraction < 1)) fail("oosFraction muss in (0, 1) liegen.");
  if (!(c.solana.solReserve >= 0 && c.solana.slippageBps >= 1)) fail("Solana-Parameter ungültig.");
  if (!/^https:\/\//.test(c.solana.rpcUrl) || !/^https:\/\//.test(c.solana.jupiterUrl)) fail("RPC- und Jupiter-URL müssen mit https:// beginnen.");
  return c;
}
