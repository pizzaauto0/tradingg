// Vergleicht die JS-Implementierung mit den Python-Ergebnissen (Fixture: test/fixtures/parity.json).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULTS, mergeConfig } from "../lib/config.js";
import { classifyMarket } from "../lib/indicators.js";
import { buildStrategy } from "../lib/strategies.js";
import { runBacktest } from "../lib/backtest.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/parity.json", import.meta.url)));
const cfg = mergeConfig(DEFAULTS, { capital: { start: 300 }, costs: { feePct: 0.10, slippagePct: 0.15 } });

test("Backtest-Kennzahlen stimmen mit Python überein", () => {
  for (const { spec, metrics } of fx.backtests) {
    const res = runBacktest(cfg, fx.candles, buildStrategy(spec));
    for (const key of Object.keys(metrics)) {
      assert.ok(Math.abs(res.metrics[key] - metrics[key]) < 1e-6 * Math.max(1, Math.abs(metrics[key])),
        `${spec.type} ${JSON.stringify(spec.params)} ${key}: JS ${res.metrics[key]} vs Python ${metrics[key]}`);
    }
  }
});

test("Marktzustand stimmt mit Python überein", () => {
  const s = classifyMarket(fx.candles), e = fx.market;
  assert.equal(s.regime, e.regime); assert.equal(s.volatility, e.volatility); assert.equal(s.volume, e.volume);
  for (const [js, py] of [["adx", "adx"], ["atrPct", "atr_pct"], ["emaFast", "ema_fast"], ["emaSlow", "ema_slow"], ["close", "close"]]) {
    assert.ok(Math.abs(s[js] - e[py]) < 1e-6 * Math.max(1, Math.abs(e[py])), `${js}: ${s[js]} vs ${e[py]}`);
  }
});

test("Strategieliste der Extension ist identisch mit der Python-Liste", async () => {
  const { defaultCandidates, STRATEGY_TYPES } = await import("../lib/strategies.js");
  const js = defaultCandidates().map(({ type, params, regimes }) => ({ type, params, regimes }));
  assert.deepEqual(js, fx.backtests.map((b) => b.spec));
  assert.ok(Object.keys(STRATEGY_TYPES).length >= 25);
});

test("Nur die 5 besten zugelassenen Strategien werden aktiv, je Typ und Markt höchstens eine", async () => {
  const { markActive, selectStrategy } = await import("../lib/pipeline.js");
  const rec = (symbol, type, sharpe) => ({ symbol, timeframe: "15m", name: `${type}-${sharpe}`, spec: { type, params: {} }, metrics: { sharpe, win_rate_pct: 60 } });
  const approved = [rec("A", "x", 5), rec("A", "x", 4.9), rec("A", "y", 3), rec("B", "x", 2.5), rec("B", "z", 2), rec("C", "w", 1.5), rec("C", "v", 1)];
  markActive(approved, 5);
  assert.deepEqual(approved.filter((a) => a.active).map((a) => a.name), ["x-5", "y-3", "x-2.5", "z-2", "w-1.5"]);
  const r = { symbol: "SOL/USD", timeframe: "15m", spec: { type: "ma_crossover", params: { fast: 9, slow: 21 } }, metrics: { sharpe: 3 } };
  assert.equal(selectStrategy([{ ...r, active: false }], "SOL/USD", "15m", { regime: "uptrend" }), null);
  assert.ok(selectStrategy([{ ...r, active: true }], "SOL/USD", "15m", { regime: "uptrend" }));
});
