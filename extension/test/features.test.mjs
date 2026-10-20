// Kennzahlen, Strategie-Rangliste, CSV, Verlustserien-Pause, Drawdown-Notbremse, Tagesbericht.
import test from "node:test";
import assert from "node:assert/strict";
import { byStrategy, performance, tradesToCsv } from "../lib/profit.js";
import { installFakeChrome, makeCandles, marketFetch, TF_MS } from "./helpers.mjs";
import { handle, runTick, getStatus, getAccount, whenIdle } from "../lib/controller.js";

const D = (y, m, d, h = 12) => new Date(y, m - 1, d, h).toISOString();
const ex = (ts, pnl, strategy = "breakout(55,20)", bot = "crypto") => ({ ts, bot, action: "EXIT", symbol: "SOL/USD", price: 100, amount: 1, fee: 0.1, pnl, strategy, regime: "uptrend", reason: "x" });

test("Kennzahlen: Trefferquote, Profitfaktor, Serien, bester/schlechtester Tag, Drawdown", () => {
  const trades = [ex(D(2026, 1, 5), 10), ex(D(2026, 1, 5, 14), -4), ex(D(2026, 1, 6), 6), ex(D(2026, 1, 7), -3), ex(D(2026, 1, 8), -2), ex(D(2026, 1, 9), -5),
    { ts: D(2026, 1, 9), action: "ENTRY", fee: 0.1 }];
  const log = [[1, 300], [2, 310], [3, 306], [4, 312], [5, 301], [6, 304]];
  const p = performance(trades, log);
  assert.equal(p.trades, 6); assert.equal(p.wins, 2); assert.ok(Math.abs(p.winRate - 33.333) < 0.01);
  assert.ok(Math.abs(p.profitFactor - 16 / 14) < 1e-9); assert.ok(Math.abs(p.expectancy - 2 / 6) < 1e-9);
  assert.equal(p.avgWin, 8); assert.equal(p.avgLoss, -3.5); assert.ok(Math.abs(p.payoff - 8 / 3.5) < 1e-9);
  assert.equal(p.maxLossStreak, 3); assert.equal(p.streak, -3); assert.equal(p.maxWinStreak, 1);
  assert.equal(p.best, 10); assert.equal(p.worst, -5);
  assert.equal(p.bestDay[1], 6); assert.equal(p.worstDay[1], -5);                       // 5.1.: +6, 6.1.: +6 (erster), 9.1.: −5
  assert.ok(Math.abs(p.maxDrawdown - 11) < 1e-9 && Math.abs(p.maxDrawdownPct - (11 / 312) * 100) < 1e-9);
  assert.equal(p.peak, 312); assert.equal(p.drawdown, 8);
  assert.equal(performance([], []).winRate, null);
});

test("Strategie-Rangliste und CSV-Export", () => {
  const t = [ex(D(2026, 1, 5), 10, "breakout(55,20)"), ex(D(2026, 1, 6), -2, "breakout(20,10)"), ex(D(2026, 1, 7), -4, "connors_rsi2(...)"), ex(D(2026, 1, 8), 1, "Test · connors_rsi2(x)"), ex(D(2026, 1, 9), 3, "Manuell")];
  const r = byStrategy(t);
  assert.deepEqual(r.map((x) => x.name), ["breakout", "Manuell", "connors_rsi2"]);   // sortiert nach Gewinn; Parameter und „Test ·“ werden zusammengefasst
  assert.equal(r[0].trades, 2); assert.equal(r[0].pnl, 8); assert.equal(r[2].pnl, -3);
  const csv = tradesToCsv([{ ts: "2026-01-05T10:00:00Z", bot: "fx", symbol: "EUR/USD", action: "EXIT", price: 1.0832, amount: 100, fee: 0.1, pnl: -1.5, strategy: "a;b", reason: 'sagt "hi"\nzweite Zeile', equity: 299.5 }]);
  assert.ok(csv.startsWith("﻿\"Zeit\";\"Bot\""));
  const row = csv.split("\r\n")[1];
  assert.match(row, /"1,0832";"100";"0,1";"-1,5";"a;b"/); assert.match(row, /"sagt ""hi"" zweite Zeile"$/);
});

const T0 = Math.floor(Date.now() / TF_MS) * TF_MS - 3 * TF_MS;
const at = (lastT, extra = 5000) => new Date(lastT + TF_MS + extra);
const flat = (n, px = 100) => makeCandles(n, T0, (i) => px + Math.sin(i / 3) * 0.2);
const shifted = (df, k = 1) => ({ ...df, t: df.t.map((t) => t + k * TF_MS) });
async function setup(patch) {
  await whenIdle();   // keinen Durchlauf des vorigen Tests in den neuen Speicher hineinlaufen lassen
  installFakeChrome();
  await handle({ type: "saveConfig", patch: { assets: ["SOL"], capital: { start: 1000 }, ...patch } });
  const world = { dfs: { "SOL/USD": flat(1500) } };
  return { world, f: marketFetch(world), px: world.dfs["SOL/USD"].close.at(-1) };
}

test("Verlustserie: nach N Verlusten in Folge pausieren die Käufe dieses Bots", async () => {
  const { f, px } = await setup({ safety: { maxLossStreak: 2, pauseHours: 3 } });
  for (let i = 0; i < 2; i++) {
    await handle({ type: "buy", symbol: "SOL/USD", usd: 100, stop: px * 0.98 }, f);
    await handle({ type: "sell", symbol: "SOL/USD" }, f);                              // Gebühren → Verlust
  }
  const st = (await chrome.storage.local.get("botState_paper")).botState_paper;
  assert.ok(st.pauseUntil && Date.parse(st.pauseUntil) > Date.now() + 2.9 * 3.6e6, "Pause gesetzt");
  assert.equal(st.lossStreak, 0);
  assert.ok((await getStatus()).events.some((e) => /2 Verluste in Folge/.test(e.text)));
  const key = "botState_paper";
  st.approved = [{ symbol: "SOL/USD", timeframe: "15m", spec: { type: "breakout", params: { lookback: 10, exit_lookback: 5 }, regimes: ["uptrend", "sideways", "downtrend"] }, name: "b", metrics: { sharpe: 2, return_pct: 5 } }];
  st.lastRefresh = new Date().toISOString();
  await chrome.storage.local.set({ [key]: st });
  await handle({ type: "saveConfig", patch: { safety: { maxLossStreak: 0 } } });         // Ein Gewinn setzt die Serie zurück; 0 = aus
  assert.equal((await handle({ type: "getConfig" })).safety.maxLossStreak, 0);
});

test("Notbremse: fällt das Eigenkapital zu weit unter den Höchststand, schließt alles und stoppt alle Bots", async () => {
  const { world, f, px } = await setup({ safety: { maxDrawdownPct: 0.3, maxLossStreak: 0 } });
  await handle({ type: "buy", symbol: "SOL/USD", usd: 200, stop: px * 0.97 }, f);
  await handle({ type: "start" }, f); await whenIdle();
  await runTick({ fetchFn: f, now: at(world.dfs["SOL/USD"].t.at(-1)) });
  assert.equal(Object.keys((await getStatus()).state.positions).length, 1, "Kurs unverändert: Bremse löst nicht aus");
  assert.equal(await chrome.storage.local.get("breaker").then((r) => r.breaker ?? null), null);
  const next = shifted(flat(1501, px * 0.98));                                         // −2 %: Verlust ca. 4 USD = 0,4 % > 0,3 %, Stop (−3 %) nicht erreicht
  next.low = next.low.map((x) => Math.max(x, px * 0.975));
  world.dfs["SOL/USD"] = next;
  await runTick({ fetchFn: f, now: at(next.t.at(-1)) });
  const s = await getStatus(), acc = await getAccount();
  assert.equal(Object.keys(s.state.positions).length, 0, "Position geschlossen");
  assert.ok(acc.bots.every((b) => !b.enabled), "alle Bots gestoppt");
  const br = (await chrome.storage.local.get("breaker")).breaker;
  assert.ok(br && br.equity < br.peak);
  assert.ok(s.events.some((e) => /NOT-AUS-BREMSE/.test(e.text)));
  await handle({ type: "start" }, f);                                                  // bewusster Neustart räumt die Bremse ab
  assert.equal((await chrome.storage.local.get("breaker")).breaker, null);
  await handle({ type: "stop" });
  await whenIdle();
});

test("Tagesbericht: einmal pro Tag an den Discord-Webhook; getProfit liefert Kennzahlen und Rangliste; Export liefert CSV", async () => {
  const { world, f } = await setup({ discord: { enabled: true, webhook: "https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-JKL", dailyReport: true, dailyHour: 0 } });
  const posts = [], inner = f;
  const g = async (url, opt) => { if (String(url).startsWith("https://discord.com/")) { posts.push(JSON.parse(opt.body).content); return { ok: true, status: 204, json: async () => ({}) }; } return inner(url, opt); };
  await handle({ type: "buy", symbol: "SOL/USD", usd: 100 }, g);
  await handle({ type: "sell", symbol: "SOL/USD" }, g);
  await handle({ type: "buy", symbol: "SOL/USD", usd: 100 }, g);
  posts.length = 0;
  await handle({ type: "start" }, g); await whenIdle();
  await runTick({ fetchFn: g, now: new Date() });
  await runTick({ fetchFn: g, now: new Date(Date.now() + 1000) });
  const rep = posts.filter((p) => p.includes("Tagesbericht"));
  assert.equal(rep.length, 1, "nur ein Tagesbericht pro Tag");
  assert.match(rep[0], /Heute [+-]/); assert.match(rep[0], /1 Verkäufe/); assert.match(rep[0], /Offene Positionen \(1\)/); assert.match(rep[0], /Bester Trade/);
  const P = await handle({ type: "getProfit" });
  assert.equal(P.perf.trades, 1); assert.equal(P.strategies[0].name, "Manuell"); assert.equal(P.breaker, null);
  const x = await handle({ type: "exportTrades" });
  assert.equal(x.count, 3); assert.ok(x.csv.startsWith("﻿"));
});
