// Standard-Konfiguration (entspricht config.solana.yaml des Python-Bots) und Validierung.
import { timeframeSeconds } from "./util.js";

// Handelbare Märkte (nur liquide Hauptwerte, keine Memecoins). Zusammen mit USDC auf Solana über Jupiter handelbar.
// mint = Token-Adresse; die Nachkommastellen liest der Bot von der Chain. Kursdaten: kraken (Live + Notfall-Historie),
// bitstamp/coinbase (längere Historie, falls dort gelistet). Fehlt ein Markt bei einer Quelle, wird er im Scan übersprungen
// und unter „Probleme“ gemeldet – nichts bricht. ACHTUNG: Die Token-Adressen und Börsen-Symbole stammen aus meinem
// Gedächtnis und sind NICHT verifiziert; prüfe sie vor Live-Betrieb in einem Solana-Explorer (in den Einstellungen
// überschreibbar). Falsche Adressen fängt der Preisabgleich gegen die Börsenkurse ab (kein Trade bei > 1 % Abweichung).
export const ASSETS = {
  SOL: { symbol: "SOL/USD", kraken: "SOLUSD", bitstamp: "solusd", coinbase: "SOL-USD", mint: "So11111111111111111111111111111111111111112" },
  BTC: { symbol: "BTC/USD", kraken: "XBTUSD", bitstamp: "btcusd", coinbase: "BTC-USD", mint: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh" },
  ETH: { symbol: "ETH/USD", kraken: "ETHUSD", bitstamp: "ethusd", coinbase: "ETH-USD", mint: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs" },
  JUP: { symbol: "JUP/USD", kraken: "JUPUSD", coinbase: "JUP-USD", mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" },
  JTO: { symbol: "JTO/USD", kraken: "JTOUSD", coinbase: "JTO-USD", mint: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL" },
  PYTH: { symbol: "PYTH/USD", kraken: "PYTHUSD", coinbase: "PYTH-USD", mint: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3" },
  RAY: { symbol: "RAY/USD", kraken: "RAYUSD", coinbase: "RAY-USD", mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R" },
  RENDER: { symbol: "RENDER/USD", kraken: "RENDERUSD", coinbase: "RENDER-USD", mint: "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof" },
  HNT: { symbol: "HNT/USD", kraken: "HNTUSD", coinbase: "HNT-USD", mint: "hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux" },
  ORCA: { symbol: "ORCA/USD", kraken: "ORCAUSD", coinbase: "ORCA-USD", mint: "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE" },
  PAXG: { symbol: "PAXG/USD", kraken: "PAXGUSD", coinbase: "PAXG-USD", mint: "" }, // Gold-Token: nur Paper (keine verifizierte Solana-Adresse hinterlegt)
  W: { symbol: "W/USD", kraken: "WUSD", coinbase: "W-USD", mint: "85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ" },
};
// Währungen und Metalle (Kursdaten von Yahoo Finance, nur Paper – kein Handel über Solana). Preise sind USD je Einheit,
// damit Paper-Geld (USD) und Kurs zusammenpassen; USD/EUR ist der Kehrwert von EUR/USD (Näherung: Paper-Geld wird 1:1 als Einheit gerechnet).
// Metalle sind Futures (GC=F Gold, SI=F Silber, PL=F Platin) – Handelszeiten wie an der Terminbörse.
Object.assign(ASSETS, {
  EURUSD: { symbol: "EUR/USD", yahoo: "EURUSD=X", mint: "" },
  GBPUSD: { symbol: "GBP/USD", yahoo: "GBPUSD=X", mint: "" },
  AUDUSD: { symbol: "AUD/USD", yahoo: "AUDUSD=X", mint: "" },
  NZDUSD: { symbol: "NZD/USD", yahoo: "NZDUSD=X", mint: "" },
  USDEUR: { symbol: "USD/EUR", yahoo: "EURUSD=X", invert: true, mint: "" },
  XAU: { symbol: "XAU/USD", yahoo: "GC=F", mint: "" },
  XAG: { symbol: "XAG/USD", yahoo: "SI=F", mint: "" },
  XPT: { symbol: "XPT/USD", yahoo: "PL=F", mint: "" },
});
export const GROUPS = {
  fx: ["EURUSD", "GBPUSD", "AUDUSD", "NZDUSD", "USDEUR"],
  metals: ["XAU", "XAG", "XPT"],
};
export const groupOf = (key) => (GROUPS.fx.includes(key) ? "fx" : GROUPS.metals.includes(key) ? "metals" : "crypto");
// Die drei Bots der Desktop-App. Alle handeln mit EINEM gemeinsamen Paper-Konto (siehe controller.loadAccount).
export const BOTS = { fx: { label: "Währungen" }, metals: { label: "Silber & Gold" }, crypto: { label: "Krypto" } };
export const BOT_IDS = ["fx", "metals", "crypto"];
export const DEFAULT_BOT = "crypto"; // ohne Angabe gilt der Krypto-Bot – so verhalten sich alte Aufrufe (Erweiterung, Tests) wie bisher
export const botAssets = (botId) => (botId === "crypto" ? Object.keys(ASSETS).filter((k) => groupOf(k) === "crypto") : GROUPS[botId] || []);

export const symbolOf = (key) => ASSETS[key].symbol;
export const baseOf = (symbol) => symbol.split("/")[0];
export const assetOf = (symbol) => Object.values(ASSETS).find((a) => a.symbol === symbol);
export const keyOf = (symbol) => Object.keys(ASSETS).find((k) => ASSETS[k].symbol === symbol);

export const DEFAULTS = {
  liveTrading: false, // Paper-Modus ist Standard
  assets: botAssets("crypto"), // alle Märkte werden gescannt; gehandelt wird, was den Backtest besteht
  timeframe: "15m", // 5m | 15m | 30m | 1h
  capital: { start: 300 }, // Paper: Startguthaben. Live: maximal eingesetztes USDC
  risk: {
    riskPerTradePct: 1.0, maxDailyLossPct: 5.0, closePositionsOnDailyLimit: true,
    maxOpenPositions: 2, maxPositionPct: 50.0, atrPeriod: 14, atrStopMult: 2.0, takeProfitRr: 2.0,
  },
  // KI-Trailing (lib/trail.js): zieht Stop-Loss (und bei starkem Trend das Ziel) nach, sobald die Position im Plus ist. startUsd: Gewinn in USD, ab dem gesichert wird;
  // startR: oder Vielfaches des ursprünglichen Risikos; lockFraction: Anteil des aktuellen Gewinns, den der Stop sichert (0,75: bei +40 Stop bei +30).
  trail: { enabled: true, startUsd: 40, startR: 1.0, lockFraction: 0.75, extendTp: true },
  costs: { feePct: 0.26, slippagePct: 0.20 }, // je Order (Kauf UND Verkauf); bewusst hoch angesetzt – lieber zu viele Kosten als zu wenige
  backtest: {
    minCandles: 1000, minTrades: 20, minReturnPct: 2.0, maxDrawdownPct: 15.0, minSharpe: 1.0,
    minWinRatePct: 55.0, minProfitFactor: 1.2, oosFraction: 0.3, minOosReturnPct: 0.0,
    profile: "strict", // strict (Standard) | explore (gelockert) | playbook (5 feste Strategien) – die beiden letzten NUR im Paper-Modus, Strategien dann nicht bewiesen
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
  // Discord: webhook = Meldungen (Kauf/Verkauf mit Stop, Ziel, Begründung; Stundenbericht). botToken + channelId = Knöpfe für die Live-Statistik
  // (Klicks gehen von überall, der Bot verbindet sich nur ausgehend). liveMessage = eine Nachricht im Kanal, die sich jede Minute selbst aktualisiert.
  discord: { enabled: false, webhook: "", botToken: "", channelId: "", liveMessage: false,
    logEnabled: false, logWebhook: "", logLevel: "all" }, // zweiter Webhook NUR für Protokolle (alle Entscheidungen, Fehler, Ereignisse); logLevel: all | important (Handel, Warnungen, Fehler)
};

// Mindestkosten je Order (Gebühr/Spread + Rutschen, in %) – weit über den echten Kosten, damit Backtest und Paper-Handel eher zu pessimistisch sind.
// Niedrigere eingestellte Werte werden beim Laden auf diese Untergrenze angehoben (controller.loadConfig).
export const MIN_COSTS = { crypto: { feePct: 0.26, slippagePct: 0.20 }, fx: { feePct: 0.03, slippagePct: 0.03 }, metals: { feePct: 0.06, slippagePct: 0.06 } };
export const WEBHOOK_RE = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/;

// Standardwerte je Bot: Währungen/Metalle brauchen andere Zeitrahmen, Kosten und Märkte als Krypto; Kapital, Telegram und LLM sind für alle gleich.
export function botDefaults(botId) {
  if (botId === "crypto" || !BOTS[botId]) return DEFAULTS;
  const fx = botId === "fx";
  return mergeConfig(DEFAULTS, {
    assets: botAssets(botId), timeframe: "1h",
    risk: { maxPositionPct: 33, maxOpenPositions: 2 },
    costs: MIN_COSTS[botId],
    backtest: { minCandles: 1000 },
  });
}

// Gelockerte Mindestwerte des Erkundungsmodus (nur Paper): zeigt Trades, beweist aber nichts.
export const EXPLORE_THRESHOLDS = { minTrades: 8, minReturnPct: 0, maxDrawdownPct: 25, minSharpe: 0, minWinRatePct: 35, minProfitFactor: 1.0, minOosReturnPct: -5 };
export const effectiveThresholds = (bt) => (bt.profile === "explore" ? { ...bt, ...EXPLORE_THRESHOLDS } : bt);

export const ALLOWED_TIMEFRAMES = ["5m", "15m", "30m", "1h", "1d"];

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
  if (!["strict", "explore", "playbook", "winrate", "final"].includes(c.backtest.profile)) fail("Prüfmodus muss 'strict', 'explore', 'playbook', 'winrate' oder 'final' sein.");
  if (c.liveTrading && c.backtest.profile !== "strict") fail("Erkundungs- und Playbook-Modus (ungeprüfte Strategien) sind nur im Paper-Modus erlaubt – für Live gilt immer 'strict'.");
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
  if (!(c.trail.startUsd > 0 && c.trail.startR > 0)) fail("Trailing: Startgewinn (USD) und Start (R) müssen größer 0 sein.");
  if (!(c.trail.lockFraction >= 0.3 && c.trail.lockFraction <= 0.95)) fail("Trailing: gesicherter Gewinnanteil muss zwischen 0,3 und 0,95 liegen.");
  if (c.discord.channelId && !/^\d{5,25}$/.test(c.discord.channelId)) fail("Discord-Kanal-ID ungültig (nur Ziffern; Kanal rechtsklicken → „Kanal-ID kopieren“, Entwicklermodus nötig).");
  if (c.discord.botToken && !/^[\w.-]{30,120}$/.test(c.discord.botToken)) fail("Discord-Bot-Token ungültig.");
  if (c.discord.logWebhook && !WEBHOOK_RE.test(c.discord.logWebhook)) fail("Log-Webhook ungültig (erwartet: https://discord.com/api/webhooks/<Zahl>/<Schlüssel>).");
  if (!["all", "important"].includes(c.discord.logLevel)) fail("Log-Stufe muss all oder important sein.");
  if (c.discord.webhook && !WEBHOOK_RE.test(c.discord.webhook)) fail("Discord-Webhook ungültig (erwartet: https://discord.com/api/webhooks/<Zahl>/<Schlüssel>).");
  if (!(Number.isInteger(c.pipeline.maxActiveStrategies) && c.pipeline.maxActiveStrategies >= 1)) fail("Anzahl aktiver Strategien muss eine ganze Zahl >= 1 sein.");
  if (!(c.backtest.oosFraction > 0 && c.backtest.oosFraction < 1)) fail("oosFraction muss in (0, 1) liegen.");
  if (!(c.solana.solReserve >= 0 && c.solana.slippageBps >= 1)) fail("Solana-Parameter ungültig.");
  if (!/^https:\/\//.test(c.solana.rpcUrl) || !/^https:\/\//.test(c.solana.jupiterUrl)) fail("RPC- und Jupiter-URL müssen mit https:// beginnen.");
  return c;
}
