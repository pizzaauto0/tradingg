// Vergleichs-Modi: Haupt-Modus + Schatten-Läufe mit eigenem Paper-Geld, Vergleichstabelle, Log-Dateien.
import test from "node:test";
import assert from "node:assert/strict";
import { installFakeChrome, makeCandles, marketFetch, TF_MS } from "./helpers.mjs";
import { handle, runTick, getStatus, getAccount, getModes, getModeDetail, whenIdle } from "../lib/controller.js";
import { MODE_IDS, shadowCfg, shadowKeys, shadowModes, summarizeMode, logText } from "../lib/compare.js";
import { botDefaults, DEFAULTS } from "../lib/config.js";

const T0 = Math.floor(Date.now() / TF_MS) * TF_MS - 3 * TF_MS;
const at = (lastT, extra = 5000) => new Date(lastT + TF_MS + extra);
const trend = (n, breakout = false) => makeCandles(n, T0, (i) => 100 + 0.12 * i + Math.sin(i / 3) * 0.1 + (breakout && i === n - 1 ? 3 : 0));
const shifted = (df, k = 1) => ({ ...df, t: df.t.map((t) => t + k * TF_MS) });

test("Hilfsfunktionen: Schatten-Modi, Einstellungen (Final-3 = Tageskerzen), Vergleichszahlen", () => {
  const cfg = { ...DEFAULTS, compare: { enabled: true, strict: true, explore: true, playbook: true, winrate: false, final: true } };
  assert.deepEqual(shadowModes(cfg), ["explore", "playbook", "final"], "Haupt-Modus (strict) und abgeschaltete Modi laufen nicht als Schatten");
  assert.deepEqual(shadowModes({ ...cfg, compare: { ...cfg.compare, enabled: false } }), []);
  assert.equal(shadowCfg(cfg, "crypto", "playbook").backtest.profile, "playbook");
  assert.equal(shadowCfg(cfg, "crypto", "playbook").liveTrading, false);
  const f = shadowCfg(cfg, "crypto", "final"); assert.equal(f.timeframe, "1d"); assert.deepEqual(f.assets, ["BTC", "ETH", "SOL", "PAXG"]);
  assert.deepEqual(shadowCfg(botDefaults("fx"), "fx", "final").assets, ["EURUSD", "GBPUSD", "AUDUSD", "NZDUSD", "USDEUR"]);
  assert.equal(shadowCfg({ ...cfg, discord: { ...cfg.discord, enabled: true } }, "crypto", "explore").discord.enabled, false, "Schatten melden nichts an Discord");
  assert.notEqual(shadowKeys("fx", "explore").state, shadowKeys("fx", "playbook").state);
  const s = summarizeMode({ capital: 1000, trades: [{ action: "ENTRY", fee: 1 }, { action: "EXIT", pnl: 20, fee: 1 }], positions: { X: { symbol: "X", amount: 2, entryPrice: 10 } }, prices: { X: 12 } });
  assert.equal(s.realized, 20); assert.equal(s.unrealized, 4); assert.equal(s.profit, 24); assert.equal(s.pct, 2.4); assert.equal(s.fees, 2);
});

async function setup() {
  await whenIdle();
  installFakeChrome();
  await handle({ type: "saveConfig", patch: { assets: ["SOL"], capital: { start: 1000 }, compare: { enabled: true } } });
  const world = { dfs: { "SOL/USD": trend(1500) } };
  return { world, f: marketFetch(world) };
}

test("Schatten-Läufe: alle übrigen Modi laufen mit eigenem Geld, verteilt über mehrere Durchläufe; Haupt-Konto bleibt unberührt", async () => {
  const { world, f } = await setup();
  const logs = new Map();
  globalThis.desktopLog = async (path, text) => { logs.set(path, text); };
  try {
    const key = "botState_paper", st = (await chrome.storage.local.get(key))[key] || {};
    st.approved = [{ symbol: "SOL/USD", timeframe: "15m", spec: { type: "breakout", params: { lookback: 10, exit_lookback: 5 }, regimes: ["uptrend"] }, name: "breakout(10,5)", metrics: { sharpe: 2, return_pct: 5 } }];
    st.lastRefresh = new Date().toISOString(); st.enabled = true;
    await chrome.storage.local.set({ [key]: st });
    const t1 = world.dfs["SOL/USD"].t.at(-1);
    let now = at(t1);
    for (let i = 0; i < 6; i++) { await runTick({ fetchFn: f, now }); now = new Date(now.getTime() + 30_000); }
    const store = (await chrome.storage.local.get(null));
    for (const m of ["explore", "playbook", "winrate", "final"]) assert.ok(store[shadowKeys("crypto", m).state], `Schatten ${m} läuft`);
    assert.ok(!store[shadowKeys("crypto", "strict").state], "der Haupt-Modus ist kein Schatten");
    for (const m of ["explore", "playbook", "winrate", "final"]) assert.equal(store[shadowKeys("crypto", m).account].cash, 1000, "eigenes Startgeld");
    assert.equal((await getAccount()).cash, 1000, "gemeinsames Konto unberührt");
    // Ausbruch-Kerze: ein Schatten-Modus mit zugelassener Breakout-Strategie kauft mit eigenem Geld
    const pk = shadowKeys("crypto", "playbook").state, ps = (await chrome.storage.local.get(pk))[pk];
    ps.approved = [{ symbol: "SOL/USD", timeframe: "15m", spec: { type: "breakout", params: { lookback: 10, exit_lookback: 5 }, regimes: ["uptrend"] }, name: "breakout(10,5)", metrics: { sharpe: 2, return_pct: 5 } }];
    ps.lastRefresh = new Date().toISOString();
    await chrome.storage.local.set({ [pk]: ps });
    world.dfs = { "SOL/USD": shifted(trend(1501, true)) };
    now = at(world.dfs["SOL/USD"].t.at(-1));
    for (let i = 0; i < 2; i++) { await runTick({ fetchFn: f, now }); now = new Date(now.getTime() + 30_000); }
    const rows = (await getModes()).rows;
    assert.equal(rows.length, 15, "3 Bots × 5 Modi");
    const crypto = rows.filter((r) => r.bot === "crypto");
    assert.deepEqual(crypto.map((r) => r.mode), MODE_IDS);
    assert.equal(crypto.find((r) => r.mode === "strict").main, true);
    assert.ok(crypto.filter((r) => !r.main && !r.off).length === 4);
    assert.ok(rows.filter((r) => r.bot !== "crypto").every((r) => r.off || r.main || r.running === false || r.running === true));
    const bought = crypto.filter((r) => !r.main).map((r) => r.open).reduce((a, b) => a + b, 0) + crypto.filter((r) => !r.main).map((r) => r.trades).reduce((a, b) => a + b, 0);
    assert.ok(bought >= 1, "mindestens ein Schatten-Modus hat gehandelt");
    const acc = await getAccount();
    const sh = await chrome.storage.local.get(null);
    const shadowCash = ["explore", "playbook", "winrate", "final"].map((m) => sh[shadowKeys("crypto", m).account].cash);
    assert.ok(shadowCash.some((c) => c < 1000), "Schatten-Geld verändert sich unabhängig");
    assert.equal(acc.cash + acc.held, acc.equity);
    // Detailansicht eines Schatten-Modus
    const d = await getModeDetail("crypto", "playbook");
    assert.equal(d.main, false); assert.ok(d.active.length >= 1); assert.equal(d.capital, 1000); assert.ok(Array.isArray(d.curve));
    assert.equal((await getModeDetail("crypto", "strict")).main, true);
    // Log-Dateien: je Modus eine Stunden- und eine 6-Stunden-Datei
    const names = [...logs.keys()];
    for (const m of ["strict", "explore", "playbook", "winrate", "final"]) {
      assert.ok(names.some((n) => n.startsWith(`crypto/${m}/stunde_`)), `Stundendatei ${m}`);
      assert.ok(names.some((n) => n.startsWith(`crypto/${m}/6h_`)), `6h-Datei ${m}`);
    }
    const strictHour = [...logs].find(([n]) => n.startsWith("crypto/strict/stunde_"))[1], shadowHour = [...logs].find(([n]) => n.startsWith("crypto/playbook/stunde_"))[1];
    assert.match(strictHour, /HAUPT-MODUS/); assert.match(shadowHour, /Schatten-Lauf, eigenes Paper-Geld/); assert.match(shadowHour, /Offene Positionen/); assert.match(shadowHour, /Käufe und Verkäufe im Zeitraum/);
    const n0 = logs.size;
    await runTick({ fetchFn: f, now });                                   // gleiche Stunde: keine neuen Dateien
    assert.equal(logs.size, n0);
    // zurücksetzen
    await handle({ type: "resetShadows" });
    assert.ok(!(await chrome.storage.local.get(null))[shadowKeys("crypto", "playbook").state]);
  } finally { delete globalThis.desktopLog; await handle({ type: "stopAll" }).catch(() => {}); await whenIdle(); }
});

test("Ohne Desktop: Vergleichs-Modi laufen nur, wenn man sie einschaltet; einzelne Modi lassen sich abschalten", async () => {
  await whenIdle();
  installFakeChrome();
  delete globalThis.__DESKTOP;
  assert.equal((await handle({ type: "getConfig" })).compare.enabled, false, "in der Erweiterung automatisch aus");
  globalThis.__DESKTOP = true;
  try { assert.equal((await handle({ type: "getConfig" })).compare.enabled, true, "in der Desktop-App automatisch an"); } finally { delete globalThis.__DESKTOP; }
  await handle({ type: "saveConfig", bot: "fx", patch: { compare: { enabled: true, winrate: false, final: false } } });
  const fx = await handle({ type: "getConfig", bot: "fx" });
  assert.deepEqual(shadowModes(fx), ["explore", "playbook"]);
  const rows = (await getModes()).rows.filter((r) => r.bot === "fx");
  assert.deepEqual(rows.filter((r) => r.off).map((r) => r.mode), ["winrate", "final"]);
});

test("Log-Text: Kopf, Konto, Gewinn, Positionen, Käufe mit Begründung", () => {
  const sum = summarizeMode({ capital: 1000, trades: [], positions: {}, prices: {} });
  const txt = logText({ bot: "fx", botLabel: "Währungen", mode: "explore", main: false, now: Date.now(), capital: 1000, equity: 1002.5, cash: 900, sum, positions: { X: { symbol: "EUR/USD", amount: 100, entryPrice: 1.08, stop: 1.07, takeProfit: 1.1, strategyName: "s" } },
    prices: { "EUR/USD": 1.09 }, trades: [{ ts: new Date().toISOString(), action: "ENTRY", symbol: "EUR/USD", price: 1.08, strategy: "s", reason: "weil\nso" }], decisions: [], active: ["EUR a"], approved: 3, hours: 1, eqDelta: 2.5, errors: [] }, "hour");
  assert.match(txt, /STUNDENBERICHT · Währungen · Modus Erkunden/); assert.match(txt, /Eigenkapital 1002\.50 USD/); assert.match(txt, /EUR\/USD 100\.00000 @ 1\.0800 → 1\.0900/); assert.match(txt, /Warum: weil so/);
});
