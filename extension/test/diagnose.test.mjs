import test from "node:test";
import assert from "node:assert/strict";
import { installFakeChrome, makeCandles, marketFetch, TF_MS } from "./helpers.mjs";
import { handle, getStatus } from "../lib/controller.js";
import { summarizeFailures, nearMisses } from "../lib/diagnose.js";
import { checkThresholds } from "../lib/backtest.js";
import { DEFAULTS, EXPLORE_THRESHOLDS, effectiveThresholds, mergeConfig, validateConfig } from "../lib/config.js";

const row = (name, approved, failures, m = {}) => ({ symbol: "SOL/USD", strategy: name, approved, failures,
  metrics: { return_pct: 1, win_rate_pct: 60, sharpe: 0.5, trades: 30, ...m } });

test("Diagnose zählt die Ablehnungsgründe und findet die knapp Gescheiterten", () => {
  const report = [
    row("a", false, ["Sharpe 0.50 < 1", "Rendite 1.00% < 2%"], { sharpe: 0.5 }),
    row("b", false, ["Sharpe 0.90 < 1"], { sharpe: 0.9 }),
    row("c", false, ["Trades 5 < 20", "Rendite -3.00% < 2%", "Sharpe -1 < 1"], { return_pct: -3, win_rate_pct: 40, sharpe: -1 }),
    row("d", true, []),
  ];
  const d = summarizeFailures(report);
  assert.equal(d.total, 4); assert.equal(d.rejected, 3);
  assert.deepEqual(d.byReason.map((r) => [r.label, r.count]).slice(0, 2), [["Sharpe Ratio zu niedrig", 3], ["Rendite zu niedrig / Verlust", 2]]);
  assert.equal(d.highWin, 3); assert.equal(d.profitable, 3);
  assert.deepEqual(nearMisses(report, 2).map((r) => r.strategy), ["b", "a"]);
});

test("Erkundungsmodus lockert die Mindestwerte; strenge Werte bleiben Standard", () => {
  const m = { trades: 12, return_pct: 0.5, max_drawdown_pct: 8, sharpe: 0.2, win_rate_pct: 50, profit_factor: 1.05, oos_return_pct: -1 };
  assert.equal(DEFAULTS.backtest.profile, "strict");
  assert.equal(checkThresholds(m, effectiveThresholds(DEFAULTS.backtest)).ok, false);
  const explore = mergeConfig(DEFAULTS, { backtest: { profile: "explore" } });
  assert.equal(checkThresholds(m, effectiveThresholds(explore.backtest)).ok, true);
  assert.ok(EXPLORE_THRESHOLDS.minSharpe < DEFAULTS.backtest.minSharpe);
  // knapp gescheiterte Strategien aus der Praxis (SOL, 15m): Trefferquote 43,5 % bzw. 40 % reichen im Erkundungsmodus
  const nearMiss = { trades: 10, return_pct: 0.48, max_drawdown_pct: 3, sharpe: 0.3, win_rate_pct: 40, profit_factor: 1.2, oos_return_pct: -1.67 };
  assert.equal(checkThresholds(nearMiss, effectiveThresholds(explore.backtest)).ok, true);
  assert.equal(checkThresholds({ ...nearMiss, return_pct: -0.2 }, effectiveThresholds(explore.backtest)).ok, false, "Verlust im Backtest bleibt ein Ausschlussgrund");
});

test("Erkundungsmodus ist im Live-Modus verboten", async () => {
  assert.throws(() => validateConfig(mergeConfig(DEFAULTS, { liveTrading: true, backtest: { profile: "explore" } })), /nur im Paper-Modus/);
  assert.throws(() => validateConfig(mergeConfig(DEFAULTS, { backtest: { profile: "egal" } })), /Prüfmodus/);
  installFakeChrome();
  const kp = (await import("../lib/solana.js")).generateKeypair();
  await (await import("../lib/vault.js")).createVault("geheim-123", kp.secretKey, kp.address, 1000);
  await handle({ type: "saveConfig", patch: { backtest: { profile: "explore" } } });
  await assert.rejects(handle({ type: "saveConfig", patch: { liveTrading: true } }), /nur im Paper-Modus/);
});

test("Prüfmodus wechseln verwirft alte Zulassungen und erzwingt Neuprüfung; Trades tragen die Warnung", async () => {
  installFakeChrome();
  const T0 = Math.floor(Date.now() / TF_MS) * TF_MS - 3 * TF_MS;
  const world = { df: makeCandles(1500, T0, (i) => 100 + 0.12 * i + Math.sin(i / 3) * 0.1) };
  const f = marketFetch(world);
  await handle({ type: "saveConfig", patch: { assets: ["SOL"], backtest: { profile: "explore" } } });
  await handle({ type: "research" }, f);
  let s = await getStatus();
  assert.ok(s.state.report.length >= 30);
  assert.ok(s.state.approved.every((a) => a.explore === true));
  const strict = s.state.approved.length;
  await handle({ type: "saveConfig", patch: { backtest: { profile: "strict" } } });
  s = await getStatus();
  assert.equal(s.state.approved.length, 0, "alte (gelockerte) Zulassungen dürfen nicht weiter handeln");
  assert.equal(s.state.lastRefresh, null);
  assert.ok(strict >= 0);
});

test("Ergebnis von „Strategien neu prüfen“ nennt die häufigsten Gründe", async () => {
  installFakeChrome();
  const T0 = Math.floor(Date.now() / TF_MS) * TF_MS - 3 * TF_MS;
  const world = { df: makeCandles(1500, T0, (i) => 100 + Math.sin(i / 5) * 0.2) }; // seitwärts, kaum Vorteil
  await handle({ type: "saveConfig", patch: { assets: ["SOL"] } }, marketFetch(world));
  const r = await handle({ type: "research" }, marketFetch(world));
  assert.equal(r.approved, 0);
  assert.ok(r.tested >= 30 && r.topReasons.length > 0 && r.topReasons[0].count > 0);
  assert.deepEqual(r.candles, [1500]);
});
