// Profit: Eigenkapital-Verlauf und Kennzahlen Heute / Woche / Monat / Insgesamt.
import test from "node:test";
import assert from "node:assert/strict";
import { appendEquity, byBot, equityAt, localMidnight, periodStats, realized, sampleCurve } from "../lib/profit.js";
import { installFakeChrome, makeCandles, marketFetch, TF_MS } from "./helpers.mjs";
import { handle, runTick, getProfit, whenIdle } from "../lib/controller.js";

const DAY = 86_400_000;
const NOW = new Date(2026, 0, 15, 14, 0, 0).getTime();   // 15.1.2026 14:00 Ortszeit
const iso = (ms) => new Date(ms).toISOString();

test("Verlauf: Abstand, Ausdünnen und Stand zu einem Zeitpunkt", () => {
  let log = [];
  log = appendEquity(log, 1000, 100); log = appendEquity(log, 1000 + 60_000, 101); log = appendEquity(log, 1000 + 6 * 60_000, 102);
  assert.deepEqual(log, [[1000, 100], [361000, 102]]);
  assert.equal(equityAt(log, 500), null); assert.equal(equityAt(log, 2000), 100); assert.equal(equityAt(log, 1e9), 102);
  let big = [];
  for (let i = 0; i < 4000; i++) big = appendEquity(big, i * 5 * 60_000, 100 + i, 5 * 60_000);
  assert.ok(big.length < 3000, "ältere Punkte werden stündlich ausgedünnt");
  assert.equal(big.at(-1)[1], 100 + 3999);
  assert.equal(sampleCurve(big, 100).length, 100);
});

test("Kennzahlen: Heute, 7 Tage, 30 Tage, Insgesamt – Eigenkapitaländerung und realisierte Zahlen netto", () => {
  const midnight = localMidnight(NOW);
  const log = [[NOW - 40 * DAY, 280], [NOW - 8 * DAY, 290], [NOW - 3 * DAY, 295], [midnight - 1000, 300], [midnight + 3600_000, 303]];
  const trades = [
    { ts: iso(NOW - 2 * DAY), bot: "fx", action: "ENTRY", fee: 0.5 }, { ts: iso(NOW - 2 * DAY + 3600_000), bot: "fx", action: "EXIT", fee: 0.5, pnl: 4 },
    { ts: iso(NOW - 20 * DAY), bot: "crypto", action: "EXIT", fee: 0.4, pnl: -1 },
    { ts: iso(midnight + 1000), bot: "crypto", action: "ENTRY", fee: 0.3 }, { ts: iso(midnight + 7200_000), bot: "crypto", action: "EXIT", fee: 0.3, pnl: -2 },
    { ts: iso(NOW - 1000), bot: "metals", action: "STOP", price: 5 },
  ];
  const p = periodStats({ log, trades, now: NOW, capital: 280, equity: 306 });
  assert.equal(p.today.base, 300); assert.equal(p.today.usd, 6); assert.ok(Math.abs(p.today.pct - 2) < 1e-9);
  assert.equal(p.week.base, 290); assert.equal(p.week.usd, 16);
  assert.equal(p.month.base, 280); assert.equal(p.total.usd, 26); assert.equal(p.total.base, 280);
  assert.equal(p.today.realized, -2); assert.equal(p.today.sells, 1); assert.equal(p.today.wins, 0); assert.equal(p.today.winRate, 0);
  assert.equal(p.week.realized, 2); assert.equal(p.week.buys, 2); assert.ok(Math.abs(p.week.fees - 1.6) < 1e-9, "Gebühren aller Käufe und Verkäufe");
  assert.equal(p.total.realized, 1); assert.equal(p.total.sells, 3);
  assert.equal(p.today.partial, false);
  // Verlauf beginnt erst heute: Basis ist der erste bekannte Stand, als „partial“ markiert
  const young = periodStats({ log: [[midnight + 1000, 300]], trades: [], now: NOW, capital: 300, equity: 301 });
  assert.equal(young.week.base, 300); assert.equal(young.week.partial, true); assert.equal(young.week.usd, 1);
  const b = byBot(trades, NOW, ["fx", "metals", "crypto"]);
  assert.equal(b.fx.week.realized, 4); assert.equal(b.crypto.today.realized, -2); assert.equal(b.crypto.total.realized, -3); assert.equal(b.metals.total.sells, 0);
  assert.equal(realized([], 0).winRate, null);
});

test("Controller: getProfit liefert Kennzahlen, Verlauf wird bei jedem Durchlauf mitgeschrieben, Kopfzeile bekommt „heute“", async () => {
  installFakeChrome();
  await handle({ type: "saveConfig", patch: { assets: ["SOL"], capital: { start: 500 } } });
  const T0 = Math.floor(Date.now() / TF_MS) * TF_MS - 3 * TF_MS, world = { dfs: { "SOL/USD": makeCandles(1500, T0) } }, f = marketFetch(world);
  let p = await getProfit();
  assert.equal(p.capital, 500); assert.equal(p.periods.total.usd, 0); assert.equal(p.curve.length, 1);
  await handle({ type: "start" }, f); await whenIdle();
  await runTick({ fetchFn: f, now: new Date() });
  const log = (await chrome.storage.local.get("equityLog")).equityLog;
  assert.ok(log.length >= 1 && log.at(-1)[1] === 500);
  const acc = await handle({ type: "getAccount" });
  assert.equal(acc.today.usd, 0); assert.equal(acc.today.pct, 0);
  p = await handle({ type: "getProfit" });
  assert.deepEqual(Object.keys(p.periods), ["today", "week", "month", "total"]); assert.deepEqual(Object.keys(p.bots), ["fx", "metals", "crypto"]);
});
