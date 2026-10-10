import test from "node:test";
import assert from "node:assert/strict";
import { installFakeChrome, makeCandles, marketFetch, TF_MS } from "./helpers.mjs";
import { handle, runTick, getStatus, whenIdle } from "../lib/controller.js";
import { parseProposals } from "../lib/research.js";
import { buildStrategy } from "../lib/strategies.js";
import { validateConfig, DEFAULTS, mergeConfig } from "../lib/config.js";

const T0 = Math.floor(Date.now() / TF_MS) * TF_MS - 3 * TF_MS; // letzte geschlossene Kerze (Testdaten liegen im aktuellen Zeitfenster)
const at = (lastT, extra = 5000) => new Date(lastT + TF_MS + extra); // kurz nach Schluss der Kerze lastT

// Sauberer Aufwärtstrend; letzte Kerze optional als Ausbruch.
function trendWorld(n, breakout = false) {
  return { df: makeCandles(n, T0, (i) => 100 + 0.12 * i + Math.sin(i / 3) * 0.1 + (breakout && i === n - 1 ? 3 : 0)) };
}
const permissive = { backtest: { minTrades: 0, minReturnPct: -1000, maxDrawdownPct: 100, minSharpe: -1000, minWinRatePct: 0, minProfitFactor: 0, minOosReturnPct: -1000 } };

async function setupPaper(world) {
  installFakeChrome();
  await handle({ type: "saveConfig", patch: { ...permissive, assets: ["SOL"] } });
  const f = marketFetch(world);
  // Nur die Breakout-Strategie zulassen: fester Datensatz, deterministischer Einstieg
  const st = await getStatus();
  assert.equal(st.cfg.liveTrading, false);
  return f;
}

async function approveBreakout(fetchFn) {
  await handle({ type: "research" }, fetchFn);
  const s = await getStatus();
  assert.ok(s.state.report.length >= 10);
  // Zulassung auf eine feste Strategie reduzieren
  const rec = { symbol: "SOL/USD", timeframe: "15m", spec: { type: "breakout", params: { lookback: 10, exit_lookback: 5 }, regimes: ["uptrend"] },
    name: "breakout(10,5)", metrics: { sharpe: 2, return_pct: 5 } };
  const key = "botState_paper";
  const st = (await chrome.storage.local.get(key))[key];
  st.approved = [rec]; st.lastRefresh = new Date().toISOString();
  await chrome.storage.local.set({ [key]: st });
}

test("Paper: Pipeline, Einstieg mit Stop/Ziel, Stop-Loss-Ausstieg, Trade-Log mit Begründung", async () => {
  const world = trendWorld(1500);
  const f = await setupPaper(world);
  await approveBreakout(f);
  await handle({ type: "start" }, f);
  await whenIdle();

  await runTick({ fetchFn: f, now: at(world.df.t.at(-1)) });            // erstes Sehen: keine Aktion
  assert.equal(Object.keys((await getStatus()).state.positions).length, 0);

  world.df = trendWorld(1501, true).df;                                  // neue Kerze mit Ausbruch
  world.df.t = world.df.t.map((t) => t + TF_MS);
  await runTick({ fetchFn: f, now: at(world.df.t.at(-1)) });
  let s = await getStatus();
  const pos = s.state.positions["SOL/USD"];
  assert.ok(pos, "Position sollte eröffnet sein");
  assert.ok(pos.stop < pos.entryPrice && pos.entryPrice < pos.takeProfit);
  const lossAtStop = pos.amount * (pos.entryPrice - pos.stop);
  assert.ok(lossAtStop <= 300 * 0.01 * 1.0001 + 1e-9, `Risiko ${lossAtStop} > 1 %`);
  assert.ok(pos.amount * pos.entryPrice <= 300 * 0.5 * 1.01, "max. Positionsgröße verletzt (Slippage-Toleranz 1 %)");
  assert.equal(s.trades[0].action, "ENTRY");
  assert.match(s.trades[0].reason, /Stop .*Ziel .*Risiko/);

  // Kurs stürzt unter den Stop -> Stop-Loss-Verkauf
  const next = trendWorld(1502, true).df;
  next.t = next.t.map((t) => t + 2 * TF_MS);
  const last = next.t.length - 1;
  next.low[last] = pos.stop * 0.98; next.close[last] = pos.stop * 0.985; next.open[last] = next.close[last - 1];
  world.df = next;
  await runTick({ fetchFn: f, now: at(next.t.at(-1)) });
  s = await getStatus();
  assert.equal(Object.keys(s.state.positions).length, 0);
  assert.equal(s.trades[0].action, "EXIT"); assert.ok(s.trades[0].pnl < 0); assert.match(s.trades[0].reason, /Stop-Loss/);
  assert.ok(Math.abs(s.trades[0].pnl) < 300 * 0.02);
});

test("Paper: Not-Aus schließt die Position und stoppt den Bot", async () => {
  const world = trendWorld(1500);
  const f = await setupPaper(world);
  await approveBreakout(f);
  await handle({ type: "start" }, f);
  await whenIdle();
  await runTick({ fetchFn: f, now: at(world.df.t.at(-1)) });
  world.df = trendWorld(1501, true).df; world.df.t = world.df.t.map((t) => t + TF_MS);
  await runTick({ fetchFn: f, now: at(world.df.t.at(-1)) });
  assert.equal(Object.keys((await getStatus()).state.positions).length, 1);
  await handle({ type: "kill" }, f);
  const s = await getStatus();
  assert.equal(Object.keys(s.state.positions).length, 0);
  assert.equal(s.state.enabled, false); assert.equal(s.state.killRequested, false);
  assert.equal(s.trades[0].reason, "Not-Aus");
});

test("Tageslimit pausiert den Handel", async () => {
  const world = trendWorld(1500);
  const f = await setupPaper(world);
  await handle({ type: "saveConfig", patch: { risk: { maxDailyLossPct: 0.2, maxPositionPct: 100 } } });
  await approveBreakout(f);
  await handle({ type: "start" }, f);
  await whenIdle();
  await runTick({ fetchFn: f, now: at(world.df.t.at(-1)) });
  world.df = trendWorld(1501, true).df; world.df.t = world.df.t.map((t) => t + TF_MS);
  await runTick({ fetchFn: f, now: at(world.df.t.at(-1)) });
  const pos = (await getStatus()).state.positions["SOL/USD"];
  const drop = trendWorld(1502, true).df; drop.t = drop.t.map((t) => t + 2 * TF_MS);
  const i = drop.t.length - 1, px = pos.entryPrice * 0.997;
  Object.assign(drop.close, { [i]: px }); drop.low[i] = px; drop.open[i] = px; drop.high[i] = px;
  world.df = drop;
  await runTick({ fetchFn: f, now: at(drop.t.at(-1)) });
  const s = await getStatus();
  assert.equal(s.state.risk.halted, true);
  assert.equal(Object.keys(s.state.positions).length, 0);
});

test("Live ohne entsperrte Wallet: keine Orders, Warnung; Live ohne Wallet nicht aktivierbar", async () => {
  installFakeChrome();
  await assert.rejects(handle({ type: "saveConfig", patch: { liveTrading: true } }), /Wallet/);
  const kp = (await import("../lib/solana.js")).generateKeypair();
  const { createVault, lock } = await import("../lib/vault.js");
  await createVault("geheim-123", kp.secretKey, kp.address, 1000);
  await handle({ type: "saveConfig", patch: { liveTrading: true } });
  await lock();
  await assert.rejects(handle({ type: "start" }), /entsperren/);
  const key = "botState_live";
  await chrome.storage.local.set({ [key]: { enabled: true, approved: [], positions: {} } });
  let called = false;
  await runTick({ fetchFn: async () => { called = true; throw new Error("kein Netzwerk erwartet"); } });
  assert.equal(called, false);
  assert.equal((await getStatus()).state.locked, true);
});

test("LLM-Antwort wird validiert, nie ausgeführt", () => {
  const out = parseProposals(`Vorschläge:\n[{"type":"ma_crossover","params":{"fast":10,"slow":30},"regimes":["uptrend"],"rationale":"x"},
    {"type":"constructor","params":{}},{"type":"__proto__","params":{}},{"type":"ma_crossover","params":{"fast":50,"slow":10}},
    {"type":"rsi_reversion","params":{"period":14,"oversold":99,"exit_level":55}}]`);
  assert.deepEqual(out.map((s) => s.type), ["ma_crossover"]);
  assert.equal(out[0].source, "llm");
  assert.throws(() => parseProposals("keine Liste"));
  assert.throws(() => buildStrategy({ type: "toString", params: {} }));
});

test("Konfiguration: Grenzen und Modus-Schutz", async () => {
  assert.throws(() => validateConfig(mergeConfig(DEFAULTS, { risk: { riskPerTradePct: 3 } })), /Risiko/);
  assert.throws(() => validateConfig(mergeConfig(DEFAULTS, { solana: { rpcUrl: "http://x" } })), /https/);
  assert.throws(() => validateConfig(mergeConfig(DEFAULTS, { timeframe: "1m" })), /Zeitrahmen/);
  assert.equal(DEFAULTS.liveTrading, false);
});

test("Aktivität: Bot zeigt Kurs, Marktphase, Strategie und protokolliert jede geprüfte Kerze", async () => {
  const world = trendWorld(1500);
  const f = await setupPaper(world);
  await approveBreakout(f);
  await handle({ type: "start" }, f);
  await whenIdle();
  await runTick({ fetchFn: f, now: at(world.df.t.at(-1)) });
  let s = await getStatus();
  const act = s.state.activity["SOL/USD"];
  assert.equal(act.regime, "uptrend");
  assert.equal(act.strategy, "breakout(lookback=10,exit_lookback=5)");
  assert.equal(typeof act.signal, "boolean");
  assert.ok(act.nextCandleAt > world.df.t.at(-1));
  assert.equal(s.state.decisions.length, 0, "erste Kerze wird nur gesehen, nicht bewertet");
  world.df = trendWorld(1501, false).df; world.df.t = world.df.t.map((t) => t + TF_MS);
  await runTick({ fetchFn: f, now: at(world.df.t.at(-1)) });
  s = await getStatus();
  assert.match(s.state.decisions[0].text, /SOL\/USD · Kerze geprüft · uptrend: breakout.*Signal (JA|nein)/);
  await handle({ type: "tickNow" }, f);
});


// ---- mehrere Märkte gleichzeitig ----
const SYMS = ["SOL/USD", "BTC/USD", "ETH/USD"];
const scaled = (df, k) => ({ ...df, open: df.open.map((x) => x * k), high: df.high.map((x) => x * k), low: df.low.map((x) => x * k), close: df.close.map((x) => x * k) });

test("Mehrere Märkte: Backtest je Markt, gleichzeitige Positionen, Positionslimit gilt über alle Märkte", async () => {
  installFakeChrome();
  await handle({ type: "saveConfig", patch: { ...permissive, assets: ["SOL", "BTC", "ETH"] } }); // maxOpenPositions Standard: 2
  const world = { dfs: Object.fromEntries(SYMS.map((s, i) => [s, scaled(trendWorld(1500).df, [1, 400, 25][i])])) };
  const f = marketFetch(world);
  const res = await handle({ type: "research" }, f);
  assert.equal(res.problems.length, 0);
  const s0 = await getStatus();
  assert.deepEqual([...new Set(s0.state.report.map((r) => r.symbol))].sort(), [...SYMS].sort());

  const key = "botState_paper", st = (await chrome.storage.local.get(key))[key];
  st.approved = SYMS.map((symbol) => ({ symbol, timeframe: "15m", spec: { type: "breakout", params: { lookback: 10, exit_lookback: 5 }, regimes: ["uptrend"] },
    name: "breakout(10,5)", metrics: { sharpe: 2, return_pct: 5 } }));
  st.lastRefresh = new Date().toISOString();
  await chrome.storage.local.set({ [key]: st });
  await handle({ type: "start" }, f);
  await whenIdle();
  await runTick({ fetchFn: f, now: at(world.dfs["SOL/USD"].t.at(-1)) });

  world.dfs = Object.fromEntries(SYMS.map((s, i) => { const d = trendWorld(1501, true).df; d.t = d.t.map((t) => t + TF_MS); return [s, scaled(d, [1, 400, 25][i])]; }));
  await runTick({ fetchFn: f, now: at(world.dfs["SOL/USD"].t.at(-1)) });
  const s = await getStatus();
  assert.deepEqual(Object.keys(s.state.positions).sort(), ["BTC/USD", "SOL/USD"], "zwei Positionen, das Limit (2) blockt ETH");
  assert.equal(Object.keys(s.state.activity).length, 3, "alle drei Märkte werden beobachtet");
  for (const pos of Object.values(s.state.positions)) {
    assert.ok(pos.stop < pos.entryPrice && pos.amount * pos.entryPrice <= 300 * 0.5 * 1.01);
    assert.ok(pos.amount * (pos.entryPrice - pos.stop) <= 300 * 0.01 * 1.0001 + 1e-9, "Risiko je Trade <= 1 %");
  }
  assert.equal(s.trades.filter((t) => t.action === "ENTRY").length, 2);

  await handle({ type: "kill" }, f);                       // Not-Aus schließt alle Positionen
  const k = await getStatus();
  assert.equal(Object.keys(k.state.positions).length, 0);
  assert.equal(k.trades.filter((t) => t.reason === "Not-Aus").length, 2);
});

test("Ein ausgefallener Markt stoppt die anderen nicht", async () => {
  installFakeChrome();
  await handle({ type: "saveConfig", patch: { ...permissive, assets: ["SOL", "BTC"] } });
  const world = { dfs: { "SOL/USD": trendWorld(1500).df } }; // BTC liefert 404
  const f = marketFetch(world);
  const res = await handle({ type: "research" }, f);
  assert.equal(res.problems.length, 1); assert.match(res.problems[0], /BTC\/USD/);
  const key = "botState_paper", st = (await chrome.storage.local.get(key))[key];
  st.enabled = true; st.lastRefresh = new Date().toISOString();
  await chrome.storage.local.set({ [key]: st });
  await runTick({ fetchFn: f, now: at(world.dfs["SOL/USD"].t.at(-1)) });
  const s = await getStatus();
  assert.ok(s.state.activity["SOL/USD"].price > 0);
  assert.match(s.state.activity["BTC/USD"].error, /404/);
});

test("Konfiguration: Assets und Token-Adressen werden geprüft", () => {
  assert.throws(() => validateConfig(mergeConfig(DEFAULTS, { assets: [] })), /assets/);
  assert.throws(() => validateConfig(mergeConfig(DEFAULTS, { assets: ["DOGE"] })), /assets/);
  assert.throws(() => validateConfig(mergeConfig(DEFAULTS, { solana: { mints: { BTC: "kein-mint" } } })), /Token-Adresse/);
  validateConfig(mergeConfig(DEFAULTS, { solana: { mints: { BTC: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh" } } }));
});
