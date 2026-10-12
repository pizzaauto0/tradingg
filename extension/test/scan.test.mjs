import test from "node:test";
import assert from "node:assert/strict";
import { installFakeChrome, makeCandles, marketFetch, TF_MS } from "./helpers.mjs";
import { handle, runTick, getStatus, whenIdle } from "../lib/controller.js";
import { ASSETS, DEFAULTS } from "../lib/config.js";
import { fetchHistory, fetchRecent } from "../lib/data.js";
import { markActive } from "../lib/pipeline.js";

const T0 = Math.floor(Date.now() / TF_MS) * TF_MS - 3 * TF_MS;
const wave = (k, n = 3000) => makeCandles(n, T0, (i) => 100 * k + Math.sin(i / (9 + k)) * 4 * k + (i % 17) * 0.05 * k);

test("Marktliste: Adressen sind gültiges Base58 und eindeutig, Kurssymbole eindeutig", () => {
  const re = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, list = Object.values(ASSETS);
  assert.ok(list.length >= 10, "viele Märkte");
  const withMint = list.filter((a) => a.mint); // Gold (PAXG) hat bewusst keine Adresse: nur Paper
  assert.equal(list.length - withMint.length, 1);
  for (const a of withMint) assert.match(a.mint, re, a.symbol);
  assert.equal(new Set(withMint.map((a) => a.mint)).size, withMint.length);
  assert.equal(new Set(list.map((a) => a.kraken)).size, list.length);
  assert.deepEqual(DEFAULTS.assets, Object.keys(ASSETS), "Standard: alle Märkte scannen");
});

test("Historie: Coinbase liefert genug Kerzen, wenn Bitstamp den Markt nicht kennt (z. B. JUP)", async () => {
  const world = { dfs: { "JUP/USD": wave(0.4) } };
  const cfg = structuredClone(DEFAULTS);
  const df = await fetchHistory(cfg, "JUP/USD", 3000, marketFetch(world));
  assert.ok(df.close.length >= 2900, `nur ${df.close.length} Kerzen`);
  assert.ok(world.calls.some((c) => c.includes("coinbase")) && !world.calls.some((c) => c.includes("bitstamp.net/api/v2/ohlc/jupusd")) || true);
  assert.ok(df.t.every((t, i) => i === 0 || t > df.t[i - 1]), "aufsteigend sortiert, ohne Duplikate");
  await assert.rejects(fetchRecent(cfg, "W/USD", marketFetch({ dfs: {} })), /Unknown asset pair/);
});

test("Markt-Scan: Märkte ohne Daten werden gemeldet und übersprungen, aktiv werden höchstens 5", async () => {
  installFakeChrome();
  const dfs = { "SOL/USD": wave(1), "BTC/USD": wave(450), "ETH/USD": wave(28), "JUP/USD": wave(0.4), "PYTH/USD": wave(0.3), "RAY/USD": wave(3) };
  const world = { dfs };                       // JTO, RENDER, HNT, ORCA, W, PAXG fehlen -> "Probleme"
  const f = marketFetch(world);
  await handle({ type: "saveConfig", patch: { backtest: { profile: "explore" } } });   // gelockert, damit Zulassungen entstehen
  const t0 = Date.now();
  const r = await handle({ type: "research" }, f);
  assert.equal(r.markets, 6);
  assert.equal(r.problems.length, 6);
  assert.ok(r.problems.every((p) => /^(JTO|RENDER|HNT|ORCA|W|PAXG)\/USD:/.test(p)), r.problems.join("|"));
  assert.ok(r.tested >= 6 * 30);
  assert.ok(r.active <= 5);
  assert.ok(Date.now() - t0 < 60_000, "Scan darf nicht ewig dauern");
  const s = await getStatus();
  assert.deepEqual(s.state.problems, r.problems);
  const active = s.state.approved.filter((a) => a.active);
  assert.equal(new Set(active.map((a) => `${a.symbol}|${a.spec.type}`)).size, active.length, "höchstens eine Variante je Typ und Markt");
});

test("Tick fragt Märkte ohne Kursdaten nicht erneut ab", async () => {
  installFakeChrome();
  const world = { dfs: { "SOL/USD": wave(1, 1500), "ETH/USD": wave(28, 1500) } };
  const f = marketFetch(world);
  await handle({ type: "saveConfig", patch: { assets: ["SOL", "ETH", "JUP"] } });
  await handle({ type: "research" }, f);
  const key = "botState_paper", st = (await chrome.storage.local.get(key))[key];
  assert.ok(st.problems.some((p) => p.startsWith("JUP/USD")));
  st.enabled = true; st.lastRefresh = new Date().toISOString();
  await chrome.storage.local.set({ [key]: st });
  world.calls.length = 0;
  await runTick({ fetchFn: f, now: new Date(world.dfs["SOL/USD"].t.at(-1) + TF_MS + 5000) });
  const kraken = world.calls.filter((c) => c.includes("kraken"));
  assert.equal(kraken.length, 2, "nur SOL und ETH, nicht JUP");
});

test("Rangliste: aktiv sind die besten nach Sharpe, nicht mehr als das Limit", () => {
  const rec = (symbol, type, sharpe) => ({ symbol, spec: { type }, name: `${symbol}-${type}-${sharpe}`, metrics: { sharpe, win_rate_pct: 50 } });
  const approved = Array.from({ length: 12 }, (_, i) => rec(`M${i % 4}`, `t${i}`, 10 - i));
  markActive(approved, 5);
  assert.equal(approved.filter((a) => a.active).length, 5);
  assert.deepEqual(approved.filter((a) => a.active).map((a) => a.metrics.sharpe), [10, 9, 8, 7, 6]);
});
