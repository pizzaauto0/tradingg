// Kosten-Filter: kein Einstieg, wenn das Ziel nicht deutlich mehr bringt als Kauf + Verkauf kosten; Stop/Ziel gelten ab dem erwarteten Kaufpreis.
import test from "node:test";
import assert from "node:assert/strict";
import { installFakeChrome, makeCandles, marketFetch, TF_MS } from "./helpers.mjs";
import { handle, runTick, getStatus, whenIdle } from "../lib/controller.js";

const T0 = Math.floor(Date.now() / TF_MS) * TF_MS - 3 * TF_MS;
const at = (lastT, extra = 5000) => new Date(lastT + TF_MS + extra);
const shifted = (df) => ({ ...df, t: df.t.map((t) => t + TF_MS) });
const permissive = { backtest: { minTrades: 0, minReturnPct: -1000, maxDrawdownPct: 100, minSharpe: -1000, minWinRatePct: 0, minProfitFactor: 0, minOosReturnPct: -1000 } };
// ruhiger Markt wie PAXG: ATR ca. 0,01 % des Kurses
const calm = (n, jump = 0) => makeCandles(n, T0, (i) => 4000 + 0.5 * i + Math.sin(i / 3) * 0.3 + (i === n - 1 ? jump : 0));
// bewegter Markt: ATR ca. 1 % des Kurses
const wild = (n, jump = 0) => makeCandles(n, T0, (i) => 100 + 0.12 * i + Math.sin(i / 2) * 3 + (i === n - 1 ? jump : 0));

async function run(make, jump, minReward, extra = {}) {
  await whenIdle();
  installFakeChrome();
  await handle({ type: "saveConfig", patch: { ...permissive, assets: ["SOL"], capital: { start: 1000 }, risk: { minRewardToCost: minReward, maxPositionPct: 50, minStopPct: 0, weakMarketShare: 0, ...extra } } });
  const world = { dfs: { "SOL/USD": make(1500) } }, f = marketFetch(world), key = "botState_paper";
  const st = (await chrome.storage.local.get(key))[key] || {};
  st.approved = [{ symbol: "SOL/USD", timeframe: "15m", spec: { type: "breakout", params: { lookback: 10, exit_lookback: 5 }, regimes: ["uptrend", "sideways", "downtrend"] }, name: "b", metrics: { sharpe: 2, return_pct: 5 } }];
  st.lastRefresh = new Date().toISOString();
  await chrome.storage.local.set({ [key]: st });
  await handle({ type: "start" }, f); await whenIdle();
  await runTick({ fetchFn: f, now: at(world.dfs["SOL/USD"].t.at(-1)) });
  world.dfs = { "SOL/USD": shifted(make(1501, jump)) };
  await runTick({ fetchFn: f, now: at(world.dfs["SOL/USD"].t.at(-1)) });
  return { s: await getStatus(), st: (await chrome.storage.local.get(key))[key] };
}

test("Ruhiger Markt: Signal vorhanden, aber kein Kauf, weil das Ziel die Kosten nicht deckt – mit Begründung", async () => {
  const { s, st } = await run(calm, 6, 2);
  assert.equal(Object.keys(s.state.positions).length, 0);
  assert.equal(s.trades.length, 0);
  assert.match(st.entryBlocked["SOL/USD"].text, /Ziel nur 0\.\d\d % entfernt, Kosten für Kauf\+Verkauf 0\.92 %/);
  assert.match(st.entryBlocked["SOL/USD"].text, /mindestens das 2-fache/);
});

test("Filter aus (0): der Trade käme zustande – und Stop/Ziel liegen ab dem echten Kaufpreis (Ziel immer über Einstand)", async () => {
  const { s } = await run(calm, 6, 0);
  const p = s.state.positions["SOL/USD"];
  assert.ok(p, "Position");
  assert.ok(p.stop < p.entryPrice && p.entryPrice < p.takeProfit, `Stop ${p.stop} < Einstand ${p.entryPrice} < Ziel ${p.takeProfit}`);
});

test("Bewegter Markt: Ziel weit genug → Kauf wie bisher", async () => {
  const { s } = await run(wild, 12, 2);
  const p = s.state.positions["SOL/USD"];
  assert.ok(p, "Position"); assert.ok((p.takeProfit - p.entryPrice) / p.entryPrice > 0.0184, "Ziel mindestens doppelt so weit wie die Kosten (0,92 %)");
  assert.ok(p.stop < p.entryPrice);
});

test("Einstellung: Wert wird geprüft", async () => {
  installFakeChrome();
  await assert.rejects(handle({ type: "saveConfig", patch: { risk: { minRewardToCost: -1 } } }), /Gewinnchance/);
  await assert.rejects(handle({ type: "saveConfig", patch: { risk: { minRewardToCost: 99 } } }), /Gewinnchance/);
  assert.equal((await handle({ type: "saveConfig", patch: { risk: { minRewardToCost: 3 } } })).risk.minRewardToCost, 3);
});

test("Mindest-Stopabstand: zu enger Stop wird auf 1,5 % verbreitert, Ergebnis-Analyse beim Verkauf", async () => {
  const { s } = await run(wild, 12, 0, { minStopPct: 1.5 });
  const p = s.state.positions["SOL/USD"];
  assert.ok(p, "Position");
  assert.ok((p.entryPrice - p.stop) / p.entryPrice >= 0.0149, `Stop mind. 1,5 % entfernt: ${p.stop} vs ${p.entryPrice}`);
});
