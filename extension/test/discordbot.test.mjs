// Discord-Knöpfe: Live-Statistik (Embed), Gateway-Bot mit Attrappe, Panel, Live-Nachricht.
import test from "node:test";
import assert from "node:assert/strict";
import { installFakeChrome, makeCandles, marketFetch, TF_MS } from "./helpers.mjs";
import { handle, runTick, getLiveStats, syncDiscord, discordBotStatus, whenIdle } from "../lib/controller.js";
import { DiscordBot, postPanel } from "../lib/discordbot.js";
import { buildStatsEmbed, tradeStats } from "../lib/stats.js";

const HOOK = "https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-JKL";
const TOKEN = ["testtoken", "x".repeat(20), "abcdefghijklmnopqrstuvwxyz"].join("_");   // kein echtes Token (Format absichtlich anders)
const CH = "987654321098765432";

const snap = () => ({
  now: "2026-01-01T12:00:00.000Z",
  account: { equity: 1012.5, cash: 700, held: 312.5, pnl: 12.5, pnlPct: 1.25, capital: 1000, bots: [] },
  bots: [{ id: "fx", label: "Währungen", enabled: true, positions: [{ symbol: "EUR/USD", amount: 1000, entryPrice: 1.08, stop: 1.07, takeProfit: 1.1, price: 1.085, strategyName: "breakout(55,20)", openedAt: "2026-01-01T10:00:00Z" }] },
    { id: "metals", label: "Silber & Gold", enabled: false, positions: [] }, { id: "crypto", label: "Krypto", enabled: true, positions: [] }],
  trades: [
    { ts: "2026-01-01T09:00:00Z", bot: "crypto", action: "ENTRY", symbol: "SOL/USD", price: 100, amount: 1, fee: 0.5, pnl: null },
    { ts: "2026-01-01T09:30:00Z", bot: "crypto", action: "EXIT", symbol: "SOL/USD", price: 104, amount: 1, fee: 0.5, pnl: 3 },
    { ts: "2026-01-01T10:00:00Z", bot: "fx", action: "ENTRY", symbol: "EUR/USD", price: 1.08, amount: 1000, fee: 0.3, pnl: null },
    { ts: "2026-01-01T10:30:00Z", bot: "metals", action: "ENTRY", symbol: "XAU/USD", price: 2000, amount: 0.1, fee: 0.4, pnl: null },
    { ts: "2026-01-01T11:00:00Z", bot: "metals", action: "EXIT", symbol: "XAU/USD", price: 1990, amount: 0.1, fee: 0.4, pnl: -2 },
  ],
});

test("Statistik: Bilanz netto, offene Trades mit Stop/Ziel, Käufe und Verkäufe", () => {
  const t = tradeStats(snap().trades);
  assert.equal(t.closed, 2); assert.equal(t.wins, 1); assert.equal(t.winRate, 50); assert.equal(t.pnl, 1); assert.ok(Math.abs(t.fees - 2.1) < 1e-9);
  const e = buildStatsEmbed(snap(), "stats"), text = JSON.stringify(e);
  assert.match(text, /Eigenkapital \*\*1012\.50 USD\*\*/); assert.match(text, /Gebühren gesamt 2\.10 USD/);
  assert.match(text, /EUR\/USD/); assert.match(text, /Stop-Loss 1\.0700/); assert.match(text, /Take-Profit 1\.1000/);
  assert.match(text, /KAUF/); assert.match(text, /VERKAUF/); assert.equal(e.color, 0x2ecc71);
  for (const f of e.fields) assert.ok(f.value.length <= 1024 && f.name.length <= 256);
  const p = buildStatsEmbed(snap(), "positions"), tr = buildStatsEmbed(snap(), "trades");
  assert.ok(!JSON.stringify(p).includes("VERKAUF") && JSON.stringify(p).includes("Stop-Loss"));
  assert.ok(JSON.stringify(tr).includes("VERKAUF") && !JSON.stringify(tr).includes("Stop-Loss"));
});

class FakeWS {
  static last;
  constructor(url) { this.url = url; this.sent = []; FakeWS.last = this; }
  send(x) { this.sent.push(JSON.parse(x)); }
  close(code) { this.closed = code; this.onclose?.({ code }); }
  emit(obj) { this.onmessage({ data: JSON.stringify(obj) }); }
}

function bot(extra = {}) {
  const calls = [];
  const fetchFn = async (url, opt) => { calls.push({ url, body: JSON.parse(opt.body) }); return { ok: true, status: 204, json: async () => ({}) }; };
  const b = new DiscordBot({ token: TOKEN, channelId: CH, getSnapshot: async () => snap(), fetchFn, WS: FakeWS, ...extra });
  return { b, calls };
}
const click = (id, over = {}) => ({ op: 0, t: "INTERACTION_CREATE", s: 5, d: { id: "I1", token: "T1", type: 3, channel_id: CH, data: { custom_id: id }, message: { flags: 0 }, ...over } });

test("Bot: meldet sich an, antwortet auf Knopfklick privat mit der Statistik", async () => {
  const { b, calls } = bot();
  b.start();
  const ws = FakeWS.last;
  assert.match(ws.url, /gateway\.discord\.gg/);
  ws.emit({ op: 10, d: { heartbeat_interval: 60_000 } });
  assert.equal(ws.sent[0].op, 2); assert.equal(ws.sent[0].d.token, TOKEN); assert.equal(ws.sent[0].d.intents, 0);
  ws.emit({ op: 0, t: "READY", s: 1, d: { user: { username: "meinbot" } } });
  assert.equal(b.status().state, "verbunden");
  ws.emit(click("stats")); await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /interactions\/I1\/T1\/callback$/);
  assert.equal(calls[0].body.type, 4); assert.equal(calls[0].body.data.flags, 64);   // nur für den Klickenden sichtbar
  assert.match(JSON.stringify(calls[0].body.data.embeds), /Live-Statistik/);
  assert.equal(calls[0].body.data.components[0].components[0].custom_id, "stats");   // „Aktualisieren“
  ws.emit(click("trades", { id: "I2", token: "T2", message: { flags: 64 } })); await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls[1].body.type, 7);                                                // Klick in privater Antwort aktualisiert sie
  ws.emit(click("trades", { id: "I3", channel_id: "111" })); await new Promise((r) => setTimeout(r, 10));
  assert.match(calls[2].body.data.content, /nur im eingerichteten Kanal/);          // fremder Kanal: keine Statistik
  ws.emit(click("boese")); ws.emit({ op: 0, t: "INTERACTION_CREATE", d: { id: "I4", token: "T4", type: 2, data: { name: "x" } } }); await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 3, "unbekannte Knöpfe/Befehle werden ignoriert");
  b.stop();
});

test("Bot: Token ungültig stoppt, Verbindungsabbruch verbindet neu", async () => {
  const { b } = bot();
  b.start();
  const ws1 = FakeWS.last;
  ws1.onclose({ code: 4004 });
  assert.equal(b.status().state, "Fehler"); assert.match(b.status().error, /Token/);
  const { b: b2 } = bot();
  b2.start();
  const ws2 = FakeWS.last;
  ws2.onclose({ code: 1006 });
  assert.match(b2.status().state, /neu/);
  b2.stop();
});

test("Panel: Knöpfe werden mit Bot-Token in den Kanal gepostet; Fehlertexte sind verständlich", async () => {
  let seen;
  await postPanel(TOKEN, CH, snap(), async (url, opt) => { seen = { url, opt }; return { ok: true, status: 200 }; });
  assert.match(seen.url, new RegExp(`channels/${CH}/messages$`));
  assert.equal(seen.opt.headers.authorization, `Bot ${TOKEN}`);
  const body = JSON.parse(seen.opt.body);
  assert.deepEqual(body.components[0].components.map((c) => c.custom_id), ["stats", "positions", "trades"]);
  await assert.rejects(postPanel(TOKEN, CH, snap(), async () => ({ ok: false, status: 403 })), /Rechte/);
  await assert.rejects(postPanel(TOKEN, CH, snap(), async () => ({ ok: false, status: 401 })), /Token/);
});

test("Einstellungen: Token wird nie zurückgegeben, Format wird geprüft; Live-Statistik aus dem Speicher; Bot startet nach Speichern", async () => {
  installFakeChrome();
  const realWS = globalThis.WebSocket;
  globalThis.WebSocket = FakeWS;   // nie echte Verbindungen im Test
  try {
  await assert.rejects(handle({ type: "saveConfig", patch: { discord: { channelId: "abc" } } }), /Kanal-ID/);
  await assert.rejects(handle({ type: "saveConfig", patch: { discord: { botToken: "kurz" } } }), /Token/);
  const f = async () => ({ ok: true, status: 200, json: async () => ({}) });
  await handle({ type: "saveConfig", patch: { discord: { enabled: true, botToken: TOKEN, channelId: CH } } }, f);
  const c = await handle({ type: "getConfig" });
  assert.equal(c.discord.botToken, "***"); assert.ok(!JSON.stringify(c).includes(TOKEN));
  const s = await getLiveStats();
  assert.equal(s.bots.length, 3); assert.equal(s.account.capital, 300);
  assert.ok(FakeWS.last, "Bot verbindet sich nach dem Speichern"); assert.notEqual(discordBotStatus().state, "aus");
  await handle({ type: "saveConfig", patch: { discord: { enabled: false } } }, f);
  assert.equal(discordBotStatus().state, "aus");
  } finally { globalThis.WebSocket = realWS; }
});

test("Live-Nachricht: wird einmal gepostet, danach nur noch bearbeitet (höchstens einmal pro Minute)", async () => {
  installFakeChrome();
  await handle({ type: "saveConfig", patch: { assets: ["SOL"], discord: { enabled: true, webhook: HOOK, liveMessage: true } } });
  const calls = [], T0 = Math.floor(Date.now() / TF_MS) * TF_MS - 3 * TF_MS, inner = marketFetch({ dfs: { "SOL/USD": makeCandles(1500, T0) } });
  const f = async (url, opt) => {
    if (String(url).startsWith("https://discord.com/")) { calls.push({ method: opt.method, url: String(url), body: JSON.parse(opt.body) }); return { ok: true, status: 200, json: async () => ({ id: "M42" }) }; }
    return inner(url, opt);
  };
  await runTick({ fetchFn: f, now: new Date(T0 + TF_MS + 5000) });
  const live = calls.filter((c) => c.body.embeds);
  assert.equal(live.length, 1); assert.equal(live[0].method, "POST"); assert.match(live[0].url, /\?wait=true$/);
  assert.match(JSON.stringify(live[0].body.embeds), /Live-Statistik/);
  await runTick({ fetchFn: f, now: new Date(T0 + TF_MS + 6000) });
  assert.equal(calls.filter((c) => c.body.embeds).length, 1, "innerhalb einer Minute keine zweite Aktualisierung");
});
