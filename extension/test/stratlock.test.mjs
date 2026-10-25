import test from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../lib/engine.js";

test("Strategie-Sperre: nach 2 Verlusten in Folge gesperrt, Gewinn setzt zurück, manuelle Trades zählen nicht", async () => {
  const msgs = [], me = { cfg: { safety: { stratMaxLosses: 2, stratPauseHours: 24 } }, state: {}, notify: async (m) => msgs.push(m), save: async () => {} };
  const pos = { symbol: "SOL/USD", strategyName: "range_support(1)", strategySpec: {} }, now = new Date("2026-01-01T10:00:00Z");
  await Engine.prototype.trackStrategy.call(me, pos, -1, now);
  assert.equal(Engine.prototype.stratLocked.call(me, "SOL/USD", pos.strategyName, now), false);
  await Engine.prototype.trackStrategy.call(me, pos, -1, now);
  assert.equal(Engine.prototype.stratLocked.call(me, "SOL/USD", pos.strategyName, now), true);
  assert.equal(Engine.prototype.stratLocked.call(me, "BTC/USD", pos.strategyName, now), false, "andere Märkte laufen weiter");
  assert.equal(Engine.prototype.stratLocked.call(me, "SOL/USD", pos.strategyName, new Date(now.getTime() + 25 * 3.6e6)), false, "nach 24 h wieder frei");
  assert.match(msgs[0], /SPERRE/);
  await Engine.prototype.trackStrategy.call(me, { ...pos, manual: true }, -5, now);
  await Engine.prototype.trackStrategy.call(me, pos, 1, now);
  assert.equal(me.state.stratLoss["SOL/USD|range_support(1)"].n, 0);
});

test("Verlust-Analyse nennt Ursachen (Rauschen, Marktschwäche, Lücke unter dem Stop)", () => {
  const me = { cfg: { timeframe: "15m", trail: { startPct: 5 } }, state: { breadth: { n: 10, weak: 9 } } };
  const pos = { symbol: "RAY/USD", entryPrice: 100, initialStop: 99, stop: 99, entryFee: 0.3, openedAt: "2026-01-01T10:00:00Z", hi: 100.1, lo: 97.5 };
  const txt = Engine.prototype.explainExit.call(me, pos, { price: 98, amount: 1.4, fee: 0.3 }, "Stop-Loss bei 99.00 ausgelöst", new Date("2026-01-01T10:02:00Z"), -3.4);
  assert.match(txt, /Kurs -2\.00 %/); assert.match(txt, /Ursache:/);
  assert.match(txt, /nach 2 Min/); assert.match(txt, /Kurslücke/); assert.match(txt, /nie nennenswert im Plus/); assert.match(txt, /9 von 10/);
});
