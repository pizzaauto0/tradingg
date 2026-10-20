// Drei Bots (Währungen, Silber & Gold, Krypto) mit gemeinsamem Paper-Konto.
import test from "node:test";
import assert from "node:assert/strict";
import { installFakeChrome, makeCandles, marketFetch, TF_MS } from "./helpers.mjs";
import { handle, runTick, getStatus, getAccount, whenIdle } from "../lib/controller.js";
import { fetchHistory, fetchRecent } from "../lib/data.js";
import { BOT_IDS, DEFAULTS, botDefaults, assetOf, keyOf } from "../lib/config.js";

const T0 = Math.floor(Date.now() / TF_MS) * TF_MS - 3 * TF_MS;
const at = (lastT, extra = 5000) => new Date(lastT + TF_MS + extra);
const permissive = { backtest: { minTrades: 0, minReturnPct: -1000, maxDrawdownPct: 100, minSharpe: -1000, minWinRatePct: 0, minProfitFactor: 0, minOosReturnPct: -1000 } };
const up = (n, base, breakout = false) => makeCandles(n, T0, (i) => base * (1 + 0.0004 * i + Math.sin(i / 3) * 0.0003 + (breakout && i === n - 1 ? 0.006 : 0)));

test("Yahoo: Kerzen werden gelesen, Lücken verworfen, USD/EUR ist der Kehrwert von EUR/USD", async () => {
  installFakeChrome();
  const cfg = { ...DEFAULTS, timeframe: "15m" };
  const df = up(400, 1.08);
  const world = { dfs: { "EUR/USD": df }, gaps: [5, 6, 399] };
  const f = marketFetch(world);
  const eur = await fetchRecent(cfg, "EUR/USD", f);
  assert.equal(eur.close.length, 397);
  const inv = await fetchRecent(cfg, "USD/EUR", f);
  assert.equal(inv.close.length, 397);
  const i = 10, j = df.t.indexOf(inv.t[i]);
  assert.ok(Math.abs(inv.close[i] - 1 / df.close[j]) < 1e-12 && inv.high[i] >= inv.low[i] && Math.abs(inv.high[i] - 1 / df.low[j]) < 1e-12);
  await assert.rejects(fetchRecent(cfg, "GBP/USD", f), /Yahoo/);
  const hist = await fetchHistory({ ...cfg, backtest: { ...cfg.backtest, minCandles: 100 } }, "EUR/USD", 300, f);
  assert.equal(hist.close.length, 300);
});

test("Bots haben getrennte Einstellungen, aber gemeinsames Kapital", async () => {
  installFakeChrome();
  const fx = await handle({ type: "getConfig", bot: "fx" });
  assert.deepEqual(fx.assets, ["EURUSD", "GBPUSD", "AUDUSD", "NZDUSD", "USDEUR"]);
  assert.equal(fx.timeframe, "1h");
  assert.deepEqual((await handle({ type: "getConfig", bot: "metals" })).assets, ["XAU", "XAG", "XPT"]);
  assert.equal((await handle({ type: "getConfig" })).assets.length, DEFAULTS.assets.length);   // ohne Angabe = Krypto wie bisher
  await handle({ type: "saveConfig", bot: "metals", patch: { timeframe: "30m", capital: { start: 1000 }, assets: ["XAU"] } });
  const m = await handle({ type: "getConfig", bot: "metals" }), c = await handle({ type: "getConfig", bot: "crypto" }), f = await handle({ type: "getConfig", bot: "fx" });
  assert.equal(m.timeframe, "30m"); assert.deepEqual(m.assets, ["XAU"]);
  assert.equal(c.timeframe, "15m"); assert.equal(f.timeframe, "1h");
  assert.equal(m.capital.start, 1000); assert.equal(c.capital.start, 1000); assert.equal(f.capital.start, 1000);
  await assert.rejects(handle({ type: "saveConfig", bot: "fx", patch: { assets: ["SOL"] } }), /assets/);   // Krypto gehört nicht in den Währungs-Bot
  const f2 = await handle({ type: "saveConfig", bot: "fx", patch: { liveTrading: true } });
  assert.equal(f2.liveTrading, false, "Live gibt es nur für Krypto");
  assert.equal((await getAccount()).cash, 1000);
});

const trend = (n, breakout = false) => makeCandles(n, T0, (i) => 100 + 0.12 * i + Math.sin(i / 3) * 0.1 + (breakout && i === n - 1 ? 3 : 0));
const scaled = (df, k) => ({ ...df, open: df.open.map((x) => x * k), high: df.high.map((x) => x * k), low: df.low.map((x) => x * k), close: df.close.map((x) => x * k) });
const shifted = (df) => ({ ...df, t: df.t.map((t) => t + TF_MS) });
const approve = async (key, symbol) => {
  const st = (await chrome.storage.local.get(key))[key] || {};
  st.approved = [{ symbol, timeframe: "15m", spec: { type: "breakout", params: { lookback: 10, exit_lookback: 5 }, regimes: ["uptrend"] }, name: "breakout(10,5)", metrics: { sharpe: 2, return_pct: 5 } }];
  st.lastRefresh = new Date().toISOString();
  await chrome.storage.local.set({ [key]: st });
};

test("Zwei Bots handeln mit einem Paper-Konto: Bargeld und Eigenkapital werden geteilt", async () => {
  installFakeChrome();
  await handle({ type: "saveConfig", patch: { ...permissive, assets: ["SOL"], capital: { start: 1000 } } });
  await handle({ type: "saveConfig", bot: "metals", patch: { ...permissive, assets: ["XAU"], timeframe: "15m" } });
  const world = { dfs: { "SOL/USD": trend(1500), "XAU/USD": scaled(trend(1500), 20) } };
  const f = marketFetch(world);
  await approve("botState_paper", "SOL/USD");
  await approve("botState_metals", "XAU/USD");
  await handle({ type: "start", bot: "crypto" }, f);
  await handle({ type: "start", bot: "metals" }, f);
  await whenIdle();
  await runTick({ fetchFn: f, now: at(world.dfs["SOL/USD"].t.at(-1)) });                                  // erstes Sehen
  assert.equal((await getAccount()).bots.reduce((x, b) => x + b.positions, 0), 0);
  const s0 = await getAccount();
  world.dfs = { "SOL/USD": shifted(trend(1501, true)), "XAU/USD": scaled(shifted(trend(1501, true)), 20) };   // neue Kerze mit Ausbruch
  await runTick({ fetchFn: f, now: at(world.dfs["SOL/USD"].t.at(-1)) });
  const sc = await getStatus("crypto"), sm = await getStatus("metals"), a = await getAccount();
  assert.deepEqual(Object.keys(sc.state.positions), ["SOL/USD"]);
  assert.deepEqual(Object.keys(sm.state.positions), ["XAU/USD"]);
  assert.equal(sc.state.paperCash, sm.state.paperCash, "beide sehen dasselbe Bargeld");
  assert.ok(a.cash < s0.cash - 100, "Käufe haben das gemeinsame Bargeld verringert");
  assert.ok(Math.abs(a.equity - 1000) < 25, `Eigenkapital bleibt ca. gleich (nur Kosten): ${a.equity}`);   // gebundenes Geld im anderen Bot ist kein „Verlust“
  assert.deepEqual(sc.trades.map((t) => t.symbol), ["SOL/USD"]);
  assert.deepEqual(sm.trades.map((t) => t.symbol), ["XAU/USD"]);
  assert.equal(a.bots.find((b) => b.id === "metals").positions, 1);
  await handle({ type: "killAll" }, f);                                  // NOT-AUS für alle
  const k = await getAccount();
  assert.equal(k.bots.reduce((x, b) => x + b.positions, 0), 0);
  assert.ok(k.bots.every((b) => !b.enabled));
  assert.ok(Math.abs(k.equity - k.cash) < 1e-9);
});

test("Bots laufen unabhängig: ein Fehler beim Währungs-Bot stoppt die anderen nicht; Konto lässt sich zurücksetzen", async () => {
  installFakeChrome();
  await handle({ type: "saveConfig", patch: { ...permissive, assets: ["SOL"] } });
  await handle({ type: "saveConfig", bot: "fx", patch: { assets: ["EURUSD"], timeframe: "15m" } });
  const world = { dfs: { "SOL/USD": up(1200, 100) } };   // keine Yahoo-Daten für EUR/USD
  const f = marketFetch(world);
  await handle({ type: "research", bot: "crypto" }, f);
  await handle({ type: "start", bot: "crypto" }, f);
  await handle({ type: "start", bot: "fx" }, f);
  await whenIdle();
  await runTick({ fetchFn: f, now: at(world.dfs["SOL/USD"].t.at(-1)) });
  assert.ok((await getStatus("crypto")).state.lastTick, "Krypto lief trotzdem");
  assert.ok((await getStatus("fx")).state.lastError, "Währungen melden ihren Fehler");
  await handle({ type: "saveConfig", patch: { capital: { start: 500 } } });
  await handle({ type: "resetAccount" });
  assert.equal((await getAccount()).cash, 500);
});

test("BOT_IDS und Standardwerte", () => {
  assert.deepEqual(BOT_IDS, ["fx", "metals", "crypto"]);
  assert.equal(botDefaults("crypto"), DEFAULTS);
  assert.equal(assetOf("XAG/USD").yahoo, "SI=F");
  assert.equal(keyOf("USD/EUR"), "USDEUR");
});
