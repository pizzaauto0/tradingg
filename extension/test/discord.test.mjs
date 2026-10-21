// Mindestkosten und Discord-Meldungen (Kauf/Verkauf mit Stop, Ziel, Begründung; Stundenbericht).
import test from "node:test";
import assert from "node:assert/strict";
import { installFakeChrome, makeCandles, marketFetch, TF_MS } from "./helpers.mjs";
import { handle, runTick, getStatus, whenIdle } from "../lib/controller.js";
import { MIN_COSTS } from "../lib/config.js";
import { chunkText, decorate } from "../lib/discord.js";

const HOOK = "https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-JKL";
const T0 = Math.floor(Date.now() / TF_MS) * TF_MS - 3 * TF_MS;
const at = (lastT, extra = 5000) => new Date(lastT + TF_MS + extra);
const permissive = { backtest: { minTrades: 0, minReturnPct: -1000, maxDrawdownPct: 100, minSharpe: -1000, minWinRatePct: 0, minProfitFactor: 0, minOosReturnPct: -1000 } };
const trend = (n, breakout = false) => makeCandles(n, T0, (i) => 100 + 0.12 * i + Math.sin(i / 3) * 0.1 + (breakout && i === n - 1 ? 3 : 0));
const shifted = (df) => ({ ...df, t: df.t.map((t) => t + TF_MS) });

function withDiscord(world) {
  const inner = marketFetch(world), posts = [];
  const f = async (url, opt) => {
    if (String(url).startsWith("https://discord.com/")) { posts.push(JSON.parse(opt.body).content); return { ok: true, status: 204, json: async () => ({}) }; }
    return inner(url, opt);
  };
  return { f, posts };
}

test("Kosten: niedrigere Eingaben werden auf die hohen Mindestwerte angehoben", async () => {
  installFakeChrome();
  await handle({ type: "saveConfig", patch: { costs: { feePct: 0, slippagePct: 0 } } });
  await handle({ type: "saveConfig", bot: "fx", patch: { costs: { feePct: 0.001, slippagePct: 0 } } });
  for (const bot of ["crypto", "fx", "metals"]) {
    const c = (await handle({ type: "getConfig", bot })).costs;
    assert.ok(c.feePct >= MIN_COSTS[bot].feePct && c.slippagePct >= MIN_COSTS[bot].slippagePct, bot);
  }
  await handle({ type: "saveConfig", bot: "metals", patch: { costs: { feePct: 0.5, slippagePct: 0.4 } } });   // höhere Werte bleiben
  assert.equal((await handle({ type: "getConfig", bot: "metals" })).costs.feePct, 0.5);
});

test("Webhook: Format wird geprüft, Adresse nie zurückgegeben, Test sendet", async () => {
  installFakeChrome();
  await assert.rejects(handle({ type: "saveConfig", patch: { discord: { enabled: true, webhook: "https://evil.example/hook" } } }), /Webhook/);
  const w = { dfs: {} }, { f, posts } = withDiscord(w);
  await assert.rejects(handle({ type: "testDiscord" }, f), /Webhook/);
  await handle({ type: "saveConfig", bot: "fx", patch: { discord: { enabled: true, webhook: HOOK } } });   // gilt für alle Bots
  const c = await handle({ type: "getConfig", bot: "metals" });
  assert.equal(c.discord.enabled, true); assert.equal(c.discord.webhook, "***");
  await handle({ type: "testDiscord" }, f);
  assert.match(posts[0], /Discord-Verbindung funktioniert/);
});

test("Kauf, Verkauf und Stundenbericht kommen mit Stop, Ziel und Begründung an Discord", async () => {
  installFakeChrome();
  await handle({ type: "saveConfig", patch: { ...permissive, assets: ["SOL"], discord: { enabled: true, webhook: HOOK } } });
  const world = { dfs: { "SOL/USD": trend(1500) } }, { f, posts } = withDiscord(world);
  await handle({ type: "research" }, f);
  const key = "botState_paper", st = (await chrome.storage.local.get(key))[key];
  st.approved = [{ symbol: "SOL/USD", timeframe: "15m", spec: { type: "breakout", params: { lookback: 10, exit_lookback: 5 }, regimes: ["uptrend"] }, name: "breakout(10,5)", metrics: { sharpe: 2, return_pct: 5 } }];
  st.lastRefresh = new Date().toISOString();
  await chrome.storage.local.set({ [key]: st });
  await handle({ type: "start" }, f);
  await whenIdle();
  assert.equal(posts.length, 1, "gleich beim Start kommt der erste Stundenbericht");   // erster Durchlauf nach „Bot starten“
  assert.match(posts[0], /Stundenbericht/); assert.match(posts[0], /SOL\/USD .*kein Kauf – /);
  const t1 = world.dfs["SOL/USD"].t.at(-1);
  await runTick({ fetchFn: f, now: at(t1) });                                    // erstes Sehen der Kerze
  await runTick({ fetchFn: f, now: at(t1, 60_000) });                            // keine zweite Meldung innerhalb einer Stunde
  assert.equal(posts.length, 1);

  world.dfs = { "SOL/USD": shifted(trend(1501, true)) };                         // Ausbruch → Kauf
  await runTick({ fetchFn: f, now: at(world.dfs["SOL/USD"].t.at(-1)) });
  const buy = posts.find((p) => p.includes("KAUF"));
  assert.ok(buy, "Kaufmeldung");
  assert.match(buy, /\[PAPER\]/); assert.match(buy, /Stop-Loss \d/); assert.match(buy, /Take-Profit \d/); assert.match(buy, /Gebühr \d/); assert.match(buy, /Warum gekauft: .*Signal der Strategie „Ausbruch“ bei Marktphase Aufwärts/); assert.match(buy, /· Ausbruch\n/, "Strategie mit Namen statt technischer Bezeichnung"); assert.ok(!/breakout\(/.test(buy));

  const pos = (await getStatus()).state.positions["SOL/USD"];
  const next = shifted(shifted(trend(1502, true)));
  const last = next.t.length - 1;
  next.low[last] = pos.stop * 0.98; next.close[last] = pos.stop * 0.985; next.open[last] = next.close[last - 1];
  world.dfs = { "SOL/USD": next };
  await runTick({ fetchFn: f, now: at(next.t.at(-1)) });
  const sell = posts.find((p) => p.includes("VERKAUF"));
  assert.ok(sell, "Verkaufsmeldung");
  assert.match(sell, /🔴/); assert.match(sell, /Einstieg \d/); assert.match(sell, /netto \(Gebühren \d/); assert.match(sell, /Stop war .*Ziel/); assert.match(sell, /Warum verkauft: Stop-Loss/);
  assert.ok(posts.every((p) => p.length <= 2000));

  // Stundenbericht nach einer Stunde: Käufe/Verkäufe seit dem letzten Bericht und Grund je Markt
  await runTick({ fetchFn: f, now: new Date(Date.now() + 3_700_000) });
  const rep = posts.filter((p) => p.includes("Stundenbericht")).at(-1);
  assert.match(rep, /1 Kauf\/Käufe, 1 Verkauf\/Verkäufe, Ergebnis -/);
});

test("Hilfsfunktionen: lange Texte werden geteilt, Köpfe verziert", () => {
  const parts = chunkText(("x".repeat(100) + "\n").repeat(60));
  assert.ok(parts.length >= 3 && parts.every((p) => p.length <= 1900));
  assert.match(decorate("EXIT SOL/USD\nVerkauf @ 1 · Ergebnis +1.00 USD"), /^✅ \*\*VERKAUF\*\*/);
  assert.match(decorate("EXIT SOL/USD\nVerkauf @ 1 · Ergebnis -1.00 USD"), /^🔴/);
  assert.match(decorate("WARNUNG: x"), /^⚠️/);
});

const LOGHOOK = "https://discord.com/api/webhooks/222222222222222222/logLOG_hook-XYZ";

test("Log-Webhook: eigener Kanal, gebündelt, mit Entscheidungen, Handel, Aktionen und Fehlern; Stufe important lässt Entscheidungen weg", async () => {
  installFakeChrome();
  await assert.rejects(handle({ type: "saveConfig", patch: { discord: { logWebhook: "https://evil.example/x" } } }), /Log-Webhook/);
  await assert.rejects(handle({ type: "saveConfig", patch: { discord: { logLevel: "viel" } } }), /Log-Stufe/);
  await handle({ type: "saveConfig", patch: { ...permissive, assets: ["SOL"], discord: { enabled: true, webhook: HOOK, logEnabled: true, logWebhook: LOGHOOK } } });
  const c = await handle({ type: "getConfig" });
  assert.equal(c.discord.logWebhook, "***"); assert.ok(!JSON.stringify(c).includes("logLOG"));
  const world = { dfs: { "SOL/USD": trend(1500) } }, inner = marketFetch(world), trade = [], logs = [];
  const f = async (url, opt) => {
    if (String(url) === HOOK) { trade.push(JSON.parse(opt.body).content); return { ok: true, status: 204, json: async () => ({}) }; }
    if (String(url) === LOGHOOK) { logs.push(JSON.parse(opt.body).content); return { ok: true, status: 204, json: async () => ({}) }; }
    return inner(url, opt);
  };
  await handle({ type: "testDiscordLog" }, f);
  assert.match(logs[0], /Log-Webhook funktioniert/); logs.length = 0;
  await handle({ type: "research" }, f);
  const key = "botState_paper", st = (await chrome.storage.local.get(key))[key];
  st.approved = [{ symbol: "SOL/USD", timeframe: "15m", spec: { type: "breakout", params: { lookback: 10, exit_lookback: 5 }, regimes: ["uptrend"] }, name: "breakout(10,5)", metrics: { sharpe: 2, return_pct: 5 } }];
  st.lastRefresh = new Date().toISOString();
  await chrome.storage.local.set({ [key]: st });
  await handle({ type: "start" }, f); await whenIdle();
  const t1 = world.dfs["SOL/USD"].t.at(-1);
  await runTick({ fetchFn: f, now: at(t1) });
  world.dfs = { "SOL/USD": shifted(trend(1501, true)) };
  await runTick({ fetchFn: f, now: at(world.dfs["SOL/USD"].t.at(-1)) });
  const all = logs.join("\n");
  assert.ok(logs.every((m) => m.startsWith("```") && m.endsWith("```") && m.length <= 2000), "gebündelt im Codeblock");
  assert.match(all, /Bot gestartet/); assert.match(all, /Strategien wurden neu geprüft/);
  assert.match(all, /SOL\/USD · Kerze .* · /, "Entscheidung je Kerze");
  assert.match(all, /\$ PAPER ENTRY SOL\/USD/); assert.match(all, /Warum gekauft/);
  assert.ok(!trade.some((m) => /Kerze .* · /.test(m)), "Entscheidungen gehen nicht in den Handels-Kanal");
  assert.ok(!all.includes(HOOK) && !all.includes("logLOG"), "keine Webhook-Adressen im Log");
  // nur wichtige Zeilen
  await handle({ type: "saveConfig", patch: { discord: { logLevel: "important" } } }, f);
  logs.length = 0;
  world.dfs = { "SOL/USD": shifted(trend(1502, true), 2) };
  await runTick({ fetchFn: f, now: at(world.dfs["SOL/USD"].t.at(-1)) });
  assert.ok(!/ · Kerze .* · /.test(logs.join("\n")), "important: keine Kerzen-Entscheidungen");
  // Fehler landen im Log
  world.dfs = {};
  logs.length = 0;
  await runTick({ fetchFn: f, now: at(world.dfs["SOL/USD"]?.t?.at(-1) ?? T0 + 4 * TF_MS) });
  assert.match(logs.join("\n"), /X PAPER Fehler im Durchlauf|! PAPER SOL\/USD: Daten nicht ladbar/);
});
