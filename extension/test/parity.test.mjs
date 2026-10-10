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
