import test from "node:test";
import assert from "node:assert/strict";
import { installFakeChrome } from "./helpers.mjs";
import { handle, pollTelegram, getStatus } from "../lib/controller.js";
import { formatStatus } from "../lib/telegram.js";

const now = () => Math.floor(Date.now() / 1000);
// Attrappe der Telegram-Bot-API: queue = noch nicht abgeholte Updates
function fakeTelegram() {
  const t = { queue: [], sent: [], calls: 0, nextId: 100 };
  t.push = (chat, text, age = 0) => t.queue.push({ update_id: t.nextId++, message: { chat: { id: chat }, text, date: now() - age } });
  t.fetch = async (url, init) => {
    t.calls++;
    const u = new URL(url), json = (b) => ({ ok: true, status: 200, json: async () => b });
    if (u.pathname.endsWith("/getUpdates")) {
      const off = +u.searchParams.get("offset");
      return json({ ok: true, result: t.queue.filter((x) => x.update_id >= off) });
    }
    if (u.pathname.endsWith("/sendMessage")) { t.sent.push(JSON.parse(init.body)); return json({ ok: true }); }
    throw new Error(url);
  };
  return t;
}

async function setup() {
  installFakeChrome();
  await handle({ type: "saveConfig", patch: { telegram: { enabled: true, token: "TOKEN", chatId: "42" }, assets: ["SOL"] } });
  const key = "botState_paper", st = (await chrome.storage.local.get(key))[key] || { positions: {}, approved: [], report: [] };
  st.enabled = true;
  await chrome.storage.local.set({ [key]: st });
  return fakeTelegram();
}

test("Erster Abruf führt keine alten Nachrichten aus (z. B. ein vergessenes /kill)", async () => {
  const t = await setup();
  t.push(42, "/stop", 5); t.push(42, "/kill ja", 5);       // lagen schon vor der Installation bereit
  await pollTelegram(t.fetch);
  assert.equal(t.sent.length, 0);
  assert.equal((await getStatus()).state.enabled, true);
  await pollTelegram(t.fetch);                            // zweiter Abruf: nichts mehr offen
  assert.equal(t.sent.length, 0);
});

test("/status antwortet im eigenen Chat; fremde Chats werden ignoriert und bekommen keine Antwort", async () => {
  const t = await setup();
  await pollTelegram(t.fetch);                            // Stand merken
  t.push(99, "/stop"); t.push(99, "/status");
  t.push(42, "/status");
  await pollTelegram(t.fetch);
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].chat_id, "42");
  assert.match(t.sent[0].text, /PAPER · läuft/);
  assert.equal((await getStatus()).state.enabled, true, "Befehl aus fremdem Chat wirkt nicht");
});

test("/stop stoppt den Handel; /start ist nur Hilfe und startet NICHT", async () => {
  const t = await setup();
  await pollTelegram(t.fetch);
  t.push(42, "/stop");
  await pollTelegram(t.fetch);
  assert.equal((await getStatus()).state.enabled, false);
  assert.match(t.sent.at(-1).text, /gestoppt/);
  t.push(42, "/start"); t.push(42, "/start@MeinBot"); t.push(42, "starte bitte");
  await pollTelegram(t.fetch);
  assert.equal((await getStatus()).state.enabled, false, "kein Start per Telegram");
  assert.equal(t.sent.slice(-3).every((m) => /Befehle:/.test(m.text)), true);
});

test("/kill braucht Bestätigung; /kill ja löst den Not-Aus aus", async () => {
  const t = await setup();
  await pollTelegram(t.fetch);
  t.push(42, "/kill");
  await pollTelegram(t.fetch);
  assert.match(t.sent.at(-1).text, /\/kill ja/);
  assert.equal((await getStatus()).state.enabled, true, "ohne Bestätigung passiert nichts");
  t.push(42, "/kill ja");
  await pollTelegram(t.fetch);
  assert.match(t.sent.at(-1).text, /NOT-AUS ausgeführt/);
  assert.equal((await getStatus()).state.enabled, false);
});

test("Alte Nachrichten (> 2 Minuten) und deaktiviertes Telegram werden ignoriert; Offset verhindert Doppelausführung", async () => {
  const t = await setup();
  await pollTelegram(t.fetch);
  t.push(42, "/stop", 600);
  await pollTelegram(t.fetch);
  assert.equal((await getStatus()).state.enabled, true);
  t.push(42, "/status");
  await pollTelegram(t.fetch); await pollTelegram(t.fetch);
  assert.equal(t.sent.length, 1, "jede Nachricht genau einmal beantwortet");
  await handle({ type: "saveConfig", patch: { telegram: { enabled: false } } });
  const before = t.calls;
  await pollTelegram(t.fetch);
  assert.equal(t.calls, before, "ohne Aktivierung keine Telegram-Anfrage");
});

test("Statustext zeigt Position, Gewinn/Verlust und Märkte", () => {
  const text = formatStatus({
    cfg: { liveTrading: false },
    state: { enabled: true, killRequested: false, lastTick: new Date().toISOString(), approved: [{ active: true }, { active: false }], risk: {}, paperCash: 250,
      positions: { "SOL/USD": { symbol: "SOL/USD", side: 1, amount: 2, entryPrice: 100, stop: 95, takeProfit: 110, strategyName: "breakout(…)" } },
      activity: { "SOL/USD": { price: 103, regime: "uptrend", signal: false }, "BTC/USD": { price: 82931, regime: "sideways", signal: true } } },
  });
  assert.match(text, /\+6\.00 USD/);
  assert.match(text, /SOL 103\.0 uptrend/);
  assert.match(text, /BTC 82931\.0 sideways ▲Signal/);
  assert.match(text, /Aktive Strategien: 1 \(2 zugelassen\)/);
});
