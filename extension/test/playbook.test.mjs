import test from "node:test";
import assert from "node:assert/strict";
import { installFakeChrome, makeCandles, marketFetch, TF_MS } from "./helpers.mjs";
import { handle, getStatus } from "../lib/controller.js";
import { PLAYBOOK, playbookCandidates, buildStrategy, STRATEGY_TYPES } from "../lib/strategies.js";
import { selectStrategy } from "../lib/pipeline.js";
import { DEFAULTS, mergeConfig, validateConfig } from "../lib/config.js";

const T0 = Math.floor(Date.now() / TF_MS) * TF_MS - 3 * TF_MS;
const wave = (k, n = 3000) => makeCandles(n, T0, (i) => 100 * k + Math.sin(i / (9 + k)) * 4 * k + (i % 17) * 0.05 * k);

test("Playbook: genau 5 feste Strategien aus dem Katalog, je Marktphase mehrere Kandidaten", () => {
  assert.equal(PLAYBOOK.length, 5);
  const cands = playbookCandidates();
  assert.equal(new Set(cands.map((c) => c.type)).size, 5, "fünf verschiedene Typen");
  for (const c of cands) { buildStrategy(c); assert.ok(c.title && c.rationale); assert.ok(Object.hasOwn(STRATEGY_TYPES, c.type)); }
  const byRegime = (r) => cands.filter((c) => buildStrategy(c).regimes.includes(r)).length;
  assert.ok(byRegime("uptrend") >= 2 && byRegime("sideways") >= 2, "für Aufwärts- und Seitwärtsphase gibt es Auswahl");
});

test("Playbook-Modus: alle 5 aktiv ohne Mindestwerte, nur Paper, Titel und strenge Werte als Information", async () => {
  installFakeChrome();
  const world = { dfs: { "SOL/USD": wave(1), "BTC/USD": wave(450) } };
  await handle({ type: "saveConfig", patch: { assets: ["SOL", "BTC"], backtest: { profile: "playbook" } } });
  const r = await handle({ type: "research" }, marketFetch(world));
  const s = await getStatus();
  assert.equal(r.tested, 10, "5 Strategien x 2 Märkte");
  assert.equal(s.state.approved.length, 10);
  assert.ok(s.state.approved.every((a) => a.active && a.explore && a.title));
  assert.deepEqual([...new Set(s.state.report.map((x) => x.title))].sort(), PLAYBOOK.map((p) => p.title).sort());
  assert.ok(s.state.report.every((x) => x.approved && Array.isArray(x.failures)), "gesetzt, strenge Verstöße nur zur Anzeige");
  assert.ok(s.state.report.some((x) => x.failures.length > 0), "mindestens eine würde die strenge Prüfung nicht bestehen");
  // Live ist gesperrt, solange das Playbook aktiv ist
  assert.throws(() => validateConfig(mergeConfig(DEFAULTS, { liveTrading: true, backtest: { profile: "playbook" } })), /nur im Paper-Modus/);
  assert.throws(() => validateConfig(mergeConfig(DEFAULTS, { backtest: { profile: "x" } })), /Prüfmodus/);
});

test("Der Bot wählt je Marktphase die am besten passende Playbook-Strategie (höchste Sharpe unter den passenden)", async () => {
  installFakeChrome();
  await handle({ type: "saveConfig", patch: { assets: ["SOL"], backtest: { profile: "playbook" } } });
  await handle({ type: "research" }, marketFetch({ dfs: { "SOL/USD": wave(1) } }));
  const { state } = await getStatus();
  const rec = (title) => state.approved.find((a) => a.title === title);
  const high = (title, sharpe) => { rec(title).metrics.sharpe = sharpe; };
  const pick = (regime) => selectStrategy(state.approved, "SOL/USD", "15m", { regime })?.record.title;
  high("Trendkanal-Ausbruch", 0.1); high("Pullback im Trend (Swing)", 2); high("Price Action: Inside Bar", 1);
  high("Range: Unterstützung kaufen", 0.5); high("Mean Reversion: Bollinger", 1.5);
  assert.equal(pick("uptrend"), "Pullback im Trend (Swing)");
  assert.equal(pick("sideways"), "Mean Reversion: Bollinger");
  high("Range: Unterstützung kaufen", 3);
  assert.equal(pick("sideways"), "Range: Unterstützung kaufen");
  assert.equal(pick("downtrend"), undefined, "im Abwärtstrend (nur Long) wartet der Bot");
});

test("Unterstützungs-Strategie: kauft nur an der Unterstützung mit bullischer Kerze, nie in der Mitte der Range", () => {
  const s = buildStrategy({ type: "range_support", params: { lookback: 20, zone: 0.25, min_range_pct: 1.0, exit_frac: 0.8 } });
  const n = 60, df = { t: [], open: [], high: [], low: [], close: [], volume: [] };
  for (let i = 0; i < n; i++) { // Range 100..110, pendelt
    const c = 105 + Math.sin(i / 3) * 4.5;
    df.t.push(i * TF_MS); df.open.push(c - 0.1); df.close.push(c); df.high.push(c + 0.5); df.low.push(c - 0.5); df.volume.push(1);
  }
  const k = n - 1;                                               // letzte Kerze: Tief an der Unterstützung, bullisch geschlossen
  df.low[k] = 100.2; df.open[k] = 100.3; df.close[k] = 101.5; df.high[k] = 101.8;
  assert.equal(s.entry(df)[k], true);
  df.low[k] = 104.5; df.open[k] = 104.6; df.close[k] = 105.5; df.high[k] = 105.8;      // Mitte der Range
  assert.equal(s.entry(df)[k], false);
  df.low[k] = 100.2; df.open[k] = 101.5; df.close[k] = 100.4; df.high[k] = 101.8;      // an der Unterstützung, aber bärische Kerze
  assert.equal(s.entry(df)[k], false);
  assert.throws(() => buildStrategy({ type: "range_support", params: { lookback: 20, zone: 0.5, min_range_pct: 1, exit_frac: 0.4 } }), /exit_frac/);
});

test("Trefferquote-Set: 5 feste Strategien, alle aktiv, nur Paper", async () => {
  const { WINRATE5 } = await import("../lib/strategies.js");
  assert.equal(WINRATE5.length, 5);
  installFakeChrome();
  await handle({ type: "saveConfig", patch: { assets: ["SOL"], backtest: { profile: "winrate" } } });
  assert.throws(() => validateConfig(mergeConfig(DEFAULTS, { liveTrading: true, backtest: { profile: "winrate" } })), /nur im Paper-Modus/);
  const world = { df: makeCandles(1500, Math.floor(Date.now() / TF_MS) * TF_MS - 3 * TF_MS) };
  await handle({ type: "research" }, marketFetch(world));
  const s = await getStatus();
  assert.deepEqual([...new Set(s.state.report.map((x) => x.title))].sort(), WINRATE5.map((p) => p.title).sort());
  assert.ok(s.state.approved.length >= 5 && s.state.approved.every((a) => a.active && a.explore));
});

test("Final-3: Tageskerzen, drei feste Strategien, Gold-Markt, nur Paper", async () => {
  const { FINAL3, fixedCandidates } = await import("../lib/strategies.js");
  const { ASSETS, ALLOWED_TIMEFRAMES } = await import("../lib/config.js");
  const { minCandlesFor } = await import("../lib/data.js");
  assert.equal(FINAL3.length, 3);
  assert.equal(fixedCandidates("final").length, 3);
  assert.ok(ALLOWED_TIMEFRAMES.includes("1d") && ASSETS.PAXG);
  assert.equal(minCandlesFor({ timeframe: "1d", backtest: { minCandles: 1000 } }), 300);
  assert.equal(minCandlesFor({ timeframe: "1h", backtest: { minCandles: 1000 } }), 1000);
  const ok = mergeConfig(DEFAULTS, { timeframe: "1d", assets: ["BTC", "PAXG"], backtest: { profile: "final" } });
  assert.equal(validateConfig(ok).timeframe, "1d");
  assert.throws(() => validateConfig(mergeConfig(DEFAULTS, { liveTrading: true, backtest: { profile: "final" } })), /nur im Paper-Modus/);
  const { SolanaWallet } = await import("../lib/solana.js");
  const w = Object.create(SolanaWallet.prototype); w.sc = { mints: {} };
  assert.throws(() => w.mintOf("PAXG/USD"), /keine Token-Adresse/);
});
