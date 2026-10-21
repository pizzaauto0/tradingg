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
