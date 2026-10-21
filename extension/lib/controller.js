// Steuerung: Konfiguration, Zustand, Durchlauf (Tick) und alle Aktionen, die das Popup auslösen kann.
import { BOTS, BOT_IDS, DEFAULT_BOT, DEFAULTS, MIN_COSTS, botAssets, botDefaults, mergeConfig, validateConfig, symbolOf } from "./config.js";
import { ema } from "./indicators.js";
import { getLocal, setLocal, removeLocal, appendTrade } from "./store.js";
import { Engine } from "./engine.js";
import { fetchHistory, fetchRecent } from "./data.js";
import { researchAndBacktest } from "./pipeline.js";
import { PaperBroker, SolanaWallet, generateKeypair, parseSecretKey } from "./solana.js";
import { createVault, decryptVault, deleteVault, getUnlockedKey, hasVault, lock, unlock, vaultAddress } from "./vault.js";
import { b58encode } from "./util.js";
import { summarizeFailures } from "./diagnose.js";
import { HELP, formatStatus, pollCommands } from "./telegram.js";
import { decorate, flushLogs, queueLog, sendDiscord } from "./discord.js";
import { DiscordBot, postPanel } from "./discordbot.js";
import { buildStatsEmbed } from "./stats.js";
import { MODE_IDS, MODE_LABEL, logText, shadowCfg, shadowKeys, shadowModes, summarizeMode } from "./compare.js";
import { appendEquity, byBot, equityAt, byStrategy, performance, periodStats, realized, sampleCurve, tradesToCsv } from "./profit.js";

let current = null; // laufender Durchlauf (Promise) – es läuft nie mehr als einer gleichzeitig
export async function whenIdle() { while (current) await current; }

// ---- Bots ---------------------------------------------------------------------------------------------------------
// Drei Bots (Währungen, Silber & Gold, Krypto) mit eigenen Märkten, Strategien, Positionen und Einstellungen, aber EINEM gemeinsamen
// Paper-Konto (Bargeld) und gemeinsamen Zugangsdaten (Telegram, LLM). Ohne Angabe gilt der Krypto-Bot mit den alten Speicherschlüsseln,
// so bleiben vorhandene Daten und der Betrieb der Erweiterung unverändert. Live-Handel (Solana-Wallet) gibt es nur für Krypto.
const isDefault = (botId) => botId === DEFAULT_BOT;
const cfgKey = (botId) => (isDefault(botId) ? "config" : `config_${botId}`);
const SHARED = ["capital", "telegram", "discord", "llm", "safety"];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => k in (o || {})).map((k) => [k, o[k]]));
export const botOf = (msg) => (BOT_IDS.includes(msg?.bot) ? msg.bot : DEFAULT_BOT);

// Kosten dürfen nicht unter die Mindestwerte des Bots fallen (lieber zu hohe als zu niedrige Gebühren).
const withMinCosts = (cfg, botId) => ({ ...cfg, costs: { feePct: Math.max(cfg.costs.feePct, MIN_COSTS[botId].feePct), slippagePct: Math.max(cfg.costs.slippagePct, MIN_COSTS[botId].slippagePct) } });

const resolveCompare = (cfg) => ({ ...cfg, compare: { ...cfg.compare, enabled: cfg.compare.enabled ?? !!globalThis.__DESKTOP } });   // null = automatisch: nur in der Desktop-App

export async function loadConfig(botId = DEFAULT_BOT) {
  const main = validateConfig(mergeConfig(DEFAULTS, await getLocal("config", {})));
  if (isDefault(botId)) return resolveCompare(withMinCosts(main, botId));
  const own = mergeConfig(botDefaults(botId), await getLocal(cfgKey(botId), {}));
  return resolveCompare(withMinCosts(validateConfig({ ...own, liveTrading: false, ...pick(main, SHARED), solana: main.solana }), botId));
}
const stateKey = (cfg, botId = DEFAULT_BOT) => (isDefault(botId) ? `botState_${cfg.liveTrading ? "live" : "paper"}` : `botState_${botId}`);
const defaultState = () => ({ enabled: false, approved: [], report: [], positions: {} });
export async function loadState(cfg, botId = DEFAULT_BOT) { return { ...defaultState(), ...(await getLocal(stateKey(cfg, botId), {})) }; }

// Gemeinsames Paper-Konto: Bargeld + Positionswert je Bot. Beim ersten Mal wird das bisherige Guthaben des Krypto-Bots übernommen.
export async function loadAccount(cfg) {
  let acc = await getLocal("paperAccount", null);
  if (!acc) acc = { cash: (await getLocal("botState_paper", {})).paper?.cash ?? cfg.capital.start, values: {} };
  acc.values ||= {};
  return acc;
}
const saveAccount = (acc) => setLocal("paperAccount", acc);

export async function saveConfig(patch, botId = DEFAULT_BOT) {
  if (!isDefault(botId)) {
    const shared = pick(patch, SHARED);
    if (Object.keys(shared).length) await saveConfig(shared, DEFAULT_BOT); // Kapital, Telegram, LLM gelten für alle Bots
    const prev = await loadConfig(botId);
    const own = { ...mergeConfig(prev, Object.fromEntries(Object.entries(patch).filter(([k]) => !SHARED.includes(k) && k !== "liveTrading" && k !== "solana"))), liveTrading: false };
    const next = validateConfig(own);
    const bad = next.assets.filter((a) => !botAssets(botId).includes(a));
    if (bad.length) throw new Error(`assets: ${bad.join(", ")} gehört nicht zum Bot „${BOTS[botId].label}“ (erlaubt: ${botAssets(botId).join(", ")}).`);
    await setLocal(cfgKey(botId), next);
    if (JSON.stringify(next.backtest) !== JSON.stringify(prev.backtest)) {
      const st = await loadState(next, botId);
      Object.assign(st, { approved: [], report: [], lastRefresh: null });
      await setLocal(stateKey(next, botId), st);
    }
    return loadConfig(botId);
  }
  const prev = await loadConfig();
  const next = validateConfig(mergeConfig(DEFAULTS, mergeConfig(prev, patch)));
  if (next.liveTrading && !(await hasVault())) throw new Error("Für den Live-Modus zuerst eine Wallet anlegen oder importieren.");
  if (next.liveTrading !== prev.liveTrading) {
    const old = await loadState(prev);
    if (old.enabled || Object.keys(old.positions).length) throw new Error("Moduswechsel nur ohne laufenden Bot und ohne offene Position.");
  }
  await setLocal("config", next);
  if (JSON.stringify(next.backtest) !== JSON.stringify(prev.backtest)) { // andere Prüfregeln -> alte Zulassungen verwerfen, beim nächsten Durchlauf neu prüfen
    const st = await loadState(next);
    Object.assign(st, { approved: [], report: [], lastRefresh: null });
    await setLocal(stateKey(next), st);
  }
  return next;
}

// ---- Benachrichtigungen / Protokoll ------------------------------------------------------------------------------
let lastNoticeAt = 0;
async function pushLog(text, botId = DEFAULT_BOT) {
  const log = await getLocal("eventLog", []);
  log.push({ ts: new Date().toISOString(), text, bot: botId });
  await setLocal("eventLog", log.slice(-100));
}

export function makeNotifier(cfg, fetchFn = fetch, botId = DEFAULT_BOT) {
  const tag = isDefault(botId) ? "" : `[${BOTS[botId].label}] `;
  const discord = (text) => cfg.discord?.enabled && cfg.discord.webhook
    ? sendDiscord(cfg.discord.webhook, `**[${cfg.liveTrading ? "LIVE" : "PAPER"}${isDefault(botId) ? "" : " · " + BOTS[botId].label}]** ${decorate(text)}`, fetchFn).catch((e) => console.warn("Discord:", e.message))
    : null;
  // Protokoll-Webhook: level info (jede Entscheidung) | trade | warn | error; Stufe „important“ lässt info weg
  const logTo = (text, level = "info") => {
    const d = cfg.discord;
    if (!d?.logEnabled || !d.logWebhook || (d.logLevel === "important" && level === "info")) return;
    const bot = isDefault(botId) ? "" : `${BOTS[botId].label} `;
    const icon = { info: "·", trade: "$", warn: "!", error: "X" }[level] || "·";
    queueLog(d.logWebhook, `${new Date().toLocaleTimeString("de-DE")} ${icon} ${cfg.liveTrading ? "LIVE" : "PAPER"} ${bot}${text}`);
  };
  const notify = async (text) => {
    console.info("NOTIFY:", tag + text);
    logTo(text, /^(WARNUNG|NOT-AUS|Tagesverlust)/.test(text) ? "warn" : /^(ENTRY|EXIT|TRAIL|TESTTRADE|STOP\/ZIEL)/.test(text) ? "trade" : "info");
    await pushLog(text, botId);
    if (/^(WARNUNG|NOT-AUS|ENTRY|EXIT|Tagesverlust)/.test(text) && globalThis.chrome?.notifications) {
      chrome.notifications.create({ type: "basic", iconUrl: "icons/icon128.png", title: `Trading-Bot [${cfg.liveTrading ? "LIVE" : "PAPER"}]`, message: (tag + text.split("\n")[0]).slice(0, 250) });
    }
    if (cfg.telegram.enabled && cfg.telegram.token && cfg.telegram.chatId) {
      try {
        await fetchFn(`https://api.telegram.org/bot${cfg.telegram.token}/sendMessage`, { method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: cfg.telegram.chatId, text: `[${cfg.liveTrading ? "LIVE" : "PAPER"}] ${tag}${text}`.slice(0, 4000) }) });
      } catch { /* Telegram-Fehler dürfen den Bot nie stoppen */ }
    }
    await discord(text);
  };
  notify.log = logTo;
  notify.report = async (text) => { console.info("REPORT:", tag + text.split("\n")[0]); await discord(text); }; // Stundenbericht: nur Discord, nicht Telegram/Ereignisliste
  return notify;
}

// ---- Ein Durchlauf (vom Alarm alle 30 s aufgerufen) ----------------------------------------------------------------
export function runTick(opts = {}) {
  if (current) return current.then(() => {}, () => {}); // läuft schon einer: dieser Aufruf wird übersprungen
  current = tickAll(opts).finally(() => { current = null; });
  return current;
}

// Alle Bots nacheinander (sie teilen sich das Paper-Konto, deshalb nie gleichzeitig). Ein Fehler in einem Bot stoppt die anderen nicht.
async function tickAll(opts) {
  for (const id of BOT_IDS) await tickOnce(id, opts);
  if (!opts?.skipShadows) await tickShadows(opts?.fetchFn, opts?.now ?? new Date());
  await recordEquity(opts?.now);
  await checkBreaker(opts?.fetchFn, opts?.now);
  await dailyReport(opts?.fetchFn, opts?.now);
  if (!opts?.skipShadows) await writeModeLogs(opts?.now ?? new Date());
  await flushLogs(opts?.fetchFn);
  await updateLiveMessage(opts?.fetchFn).catch((e) => console.warn("Discord-Live-Nachricht:", e.message));
}

// ---- Vergleichs-Modi: Schatten-Läufe mit eigenem Paper-Geld ----------------------------------------------------------
const historyCache = new Map();   // Kursverlauf für Backtests wird von allen Modi geteilt (3 Stunden gültig)
async function sharedHistories(cfg, fetchFn) {
  const out = {};
  for (const base of cfg.assets) {
    const symbol = symbolOf(base), key = `${cfg.timeframe}|${symbol}`, hit = historyCache.get(key);
    if (hit && Date.now() - hit.at < 3 * 3.6e6) { out[symbol] = hit.df; continue; }
    try { const df = await fetchHistory(cfg, symbol, cfg.pipeline.historyCandles, fetchFn); historyCache.set(key, { at: Date.now(), df }); out[symbol] = df; } catch { /* fehlt: die Prüfung meldet es als Problem */ }
  }
  return out;
}

async function tickShadow(botId, main, mode, { fetchFn, now, cache, budget }) {
  const k = shadowKeys(botId, mode), cfg = shadowCfg(main, botId, mode);
  const state = { ...defaultState(), ...(await getLocal(k.state, {})) };
  const due = !state.lastRefresh || (now - Date.parse(state.lastRefresh)) / 3.6e6 >= cfg.pipeline.revalidateHours;
  if (due) { if (budget.left <= 0) return; budget.left--; }   // höchstens zwei Neuprüfungen (Backtests) pro Durchlauf: verteilt die Rechenlast
  const account = (await getLocal(k.account, null)) || { cash: cfg.capital.start, values: {} };
  account.values ||= {};
  const events = state.events || [];
  const notify = async (text) => { events.push({ ts: now.toISOString(), text: String(text).split("\n")[0].slice(0, 300) }); };   // stumm: nichts an Discord/Telegram
  notify.log = () => {}; notify.report = async () => {};
  let trades = await getLocal(k.trades, []);
  const fr = (sym) => { const key = `${cfg.timeframe}|${sym}`; if (!cache.has(key)) cache.set(key, fetchRecent(cfg, sym, fetchFn)); return cache.get(key); };
  const engine = new Engine({ cfg, state, broker: new PaperBroker(cfg, state, account), notify, botId: `${botId}:${mode}`, fetchRecent: fr,
    logTrade: async (row) => { trades = [...trades, { ...row, bot: botId, mode }].slice(-400); },
    save: async () => { await setLocal(k.state, state); await setLocal(k.account, account); },
    refresher: async () => researchAndBacktest(cfg, fetchFn, await sharedHistories(cfg, fetchFn)) });
  try { await engine.tick(now); state.lastError = null; }
  catch (e) { state.lastError = e.message; events.push({ ts: now.toISOString(), text: `FEHLER: ${e.message}` }); }
  state.lastTick = now.toISOString();
  state.events = events.slice(-30);
  await setLocal(k.state, state); await setLocal(k.account, account); await setLocal(k.trades, trades);
  const eq = account.cash + Object.values(state.positions).reduce((x, p) => x + p.amount * (state.activity?.[p.symbol]?.price ?? p.entryPrice), 0);
  await setLocal(k.equity, appendEquity(await getLocal(k.equity, []), now.getTime(), eq));
}

async function tickShadows(fetchFn = fetch, now = new Date()) {
  const budget = { left: 2 }, cache = new Map();
  for (const botId of BOT_IDS) {
    let main;
    try { main = await loadConfig(botId); } catch { continue; }
    for (const mode of shadowModes(main)) {
      try { await tickShadow(botId, main, mode, { fetchFn, now, cache, budget }); } catch (e) { console.warn(`Schatten ${botId}/${mode}:`, e.message); }
    }
  }
}

// Daten eines Modus (Haupt oder Schatten) für Vergleich, Detailansicht und Log-Dateien
async function modeData(botId, mode, now, hours = 1) {
  const cfg = await loadConfig(botId), nowMs = now.getTime(), from = nowMs - hours * 3.6e6, main = mode === cfg.backtest.profile;
  let state, trades, eqLog, equity, cash, capital = cfg.capital.start;
  if (main) {
    state = await loadState(cfg, botId); trades = (await getLocal("trades", [])).filter((t) => (t.bot || DEFAULT_BOT) === botId); eqLog = await getLocal("equityLog", []);
    const a = await getAccount(); equity = a.equity; cash = a.cash;
  } else {
    const k = shadowKeys(botId, mode), sc = shadowCfg(cfg, botId, mode);
    state = { ...defaultState(), ...(await getLocal(k.state, {})) }; trades = await getLocal(k.trades, []); eqLog = await getLocal(k.equity, []);
    const acc = (await getLocal(k.account, null)) || { cash: sc.capital.start, values: {} };
    cash = acc.cash; equity = acc.cash + Object.values(state.positions).reduce((x, p) => x + p.amount * (state.activity?.[p.symbol]?.price ?? p.entryPrice), 0);
  }
  const evts = main ? (await getLocal("eventLog", [])).filter((e) => (e.bot || DEFAULT_BOT) === botId) : (state.events || []);
  const prices = Object.fromEntries(Object.entries(state.activity || {}).filter(([, a]) => a.price != null).map(([s, a]) => [s, a.price]));
  const sum = summarizeMode({ capital, trades, positions: state.positions, prices, eqLog: main ? [] : eqLog });
  return { bot: botId, botLabel: BOTS[botId].label, mode, main, now: nowMs, hours, capital, equity, cash, sum, positions: state.positions, prices, state, eqLog,
    trades: trades.filter((t) => Date.parse(t.ts) >= from && (t.action === "ENTRY" || t.action === "EXIT")), allTrades: trades,
    decisions: (state.decisions || []).filter((x) => Date.parse(x.ts) >= from), approved: state.approved.length,
    active: state.approved.filter((a) => a.active !== false).map((a) => `${a.symbol.split("/")[0]} ${a.title || a.name}`),
    eqDelta: equityAt(eqLog, from) != null ? equity - equityAt(eqLog, from) : null,
    // nur Meldungen aus dem Zeitraum (sonst steht eine alte Warnung in jeder späteren Stundendatei)
    errors: [...(state.lastError ? [state.lastError] : []), ...evts.filter((e) => Date.parse(e.ts) >= from && /FEHLER|WARNUNG/.test(e.text)).slice(-5).map((e) => e.text)] };
}

// Pro Modus jede Stunde eine Log-Datei und alle 6 Stunden eine zusammenfassende (nur in der Desktop-App: dort gibt es einen Ordner dafür)
async function writeModeLogs(now) {
  const write = globalThis.desktopLog;
  if (typeof write !== "function") return;
  const pad = (n) => String(n).padStart(2, "0"), day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`, hr = pad(now.getHours());
  const marks = await getLocal("logMarks", {});
  try {
    for (const botId of BOT_IDS) {
      const cfg = await loadConfig(botId);
      for (const mode of [cfg.backtest.profile, ...shadowModes(cfg)]) {
        const key = `${botId}/${mode}`, m = marks[key] || {}, hourKey = `${day}-${hr}`, sixKey = `${day}-${Math.floor(now.getHours() / 6)}`;
        if (m.h !== hourKey) {
          await write(`${botId}/${mode}/stunde_${day}_${hr}h.txt`, logText(await modeData(botId, mode, now, 1), "hour"));
          m.h = hourKey;
        }
        if (m.s !== sixKey) {
          await write(`${botId}/${mode}/6h_${day}_${hr}h.txt`, logText(await modeData(botId, mode, now, 6), "6h"));
          m.s = sixKey;
        }
        marks[key] = m;
      }
    }
  } catch (e) { console.warn("Log-Dateien:", e.message); }
  await setLocal("logMarks", marks);
}

// Vergleichstabelle: alle Modi aller Bots nebeneinander
export async function getModes(now = new Date()) {
  const rows = [];
  for (const botId of BOT_IDS) {
    const cfg = await loadConfig(botId), shadows = shadowModes(cfg);
    for (const mode of MODE_IDS) {
      const base = { bot: botId, botLabel: BOTS[botId].label, mode, label: MODE_LABEL[mode], main: mode === cfg.backtest.profile };
      if (!base.main && !shadows.includes(mode)) { rows.push({ ...base, off: true }); continue; }
      const d = await modeData(botId, mode, now, 1);
      rows.push({ ...base, equity: d.equity, profit: d.sum.profit, pct: d.sum.pct, realized: d.sum.realized, unrealized: d.sum.unrealized, open: d.sum.open, trades: d.sum.perf.trades,
        winRate: d.sum.perf.winRate, profitFactor: d.sum.perf.profitFactor, maxDrawdownPct: d.sum.perf.maxDrawdownPct, fees: d.sum.fees, approved: d.approved, active: d.active.length,
        lastTick: d.state.lastTick || null, lastError: d.state.lastError || null, running: base.main ? !!d.state.enabled : !!d.state.lastTick });
    }
  }
  return { rows, now: now.toISOString() };
}

export async function getModeDetail(botId, mode, now = new Date()) {
  const d = await modeData(botId, mode, now, 24);
  const positions = Object.values(d.positions).map((p) => ({ ...p, price: d.prices[p.symbol] ?? p.entryPrice }));
  return { bot: botId, botLabel: d.botLabel, mode, label: MODE_LABEL[mode], main: d.main, capital: d.capital, equity: d.equity, cash: d.cash, summary: d.sum, positions, active: d.active, approved: d.approved,
    trades: d.allTrades.filter((t) => t.action === "ENTRY" || t.action === "EXIT").slice(-20).reverse(), decisions: (d.state.decisions || []).slice(-12).reverse(), events: (d.state.events || []).slice(-10).reverse(),
    lastTick: d.state.lastTick || null, lastError: d.state.lastError || null, curve: d.main ? [] : sampleCurve(d.eqLog, 300), activity: d.state.activity || {} };
}

// ---- Gewinn über die Zeit ----------------------------------------------------------------------------------------------
async function recordEquity(now = new Date()) {
  try {
    const a = await getAccount();
    await setLocal("equityLog", appendEquity(await getLocal("equityLog", []), now.getTime(), a.equity));
  } catch (e) { console.warn("Eigenkapital-Verlauf:", e.message); }
}

// Notbremse: fällt das Eigenkapital um maxDrawdownPct unter den Höchststand, werden alle Positionen geschlossen und alle Bots gestoppt.
async function checkBreaker(fetchFn = fetch, now = new Date()) {
  const cfg = await loadConfig(), pct = cfg.safety.maxDrawdownPct;
  if (!(pct > 0) || await getLocal("breaker", null)) return;
  const a = await getAccount();
  if (!a.bots.some((b) => b.enabled || b.positions)) return;   // nichts läuft, nichts zu bremsen
  const peak = Math.max((await getLocal("equityPeak", null)) ?? a.capital, a.equity, a.capital);
  await setLocal("equityPeak", peak);
  if (a.equity > peak * (1 - pct / 100)) return;
  await setLocal("breaker", { ts: now.toISOString(), equity: a.equity, peak, pct });
  for (const id of BOT_IDS) { const c = await loadConfig(id), st = await loadState(c, id); if (st.enabled || Object.keys(st.positions).length) { st.killRequested = true; await setLocal(stateKey(c, id), st); } }
  await makeNotifier(cfg, fetchFn)(`NOT-AUS-BREMSE: Eigenkapital ${a.equity.toFixed(2)} USD liegt ${(((peak - a.equity) / peak) * 100).toFixed(1)} % unter dem Höchststand ${peak.toFixed(2)} USD (Grenze ${pct} %). Alle Positionen werden geschlossen, alle Bots gestoppt. Neu starten setzt den Höchststand zurück.`);
  await tickAll({ fetchFn, now, skipShadows: true });
}

// Tagesbericht (Discord-Webhook): einmal am Abend ab dailyHour Uhr Ortszeit
async function dailyReport(fetchFn = fetch, now = new Date()) {
  const cfg = await loadConfig(), d = cfg.discord;
  if (!d.enabled || !d.webhook || !d.dailyReport || now.getHours() < d.dailyHour) return;
  const today = now.toDateString();
  if ((await getLocal("dailySent", null)) === today) return;
  await setLocal("dailySent", today);
  const P = await getProfit(now), t = P.periods, perf = performance((await getLocal("trades", [])), P.curve);
  const todays = (await getLocal("trades", [])).filter((x) => Date.parse(x.ts) >= t.today.from && (x.action === "ENTRY" || x.action === "EXIT"));
  const acc = await getAccount(), open = [];
  for (const id of BOT_IDS) { const c = await loadConfig(id), st = await loadState(c, id); for (const p of Object.values(st.positions)) open.push(`• ${p.symbol} ${(((st.activity?.[p.symbol]?.price ?? p.entryPrice) / p.entryPrice - 1) * 100).toFixed(2)} % | Stop ${p.stop.toFixed(4)} | Ziel ${p.takeProfit.toFixed(4)}`); }
  const exits = todays.filter((x) => x.action === "EXIT" && x.pnl != null), best = exits.length ? exits.reduce((a, b) => (b.pnl > a.pnl ? b : a)) : null, worst = exits.length ? exits.reduce((a, b) => (b.pnl < a.pnl ? b : a)) : null;
  const sg = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
  const lines = [`🌙 **Tagesbericht** ${now.toLocaleDateString("de-DE")} · Eigenkapital ${acc.equity.toFixed(2)} USD`,
    `**Heute ${sg(t.today.usd)} USD (${sg(t.today.pct)} %)** · realisiert ${sg(t.today.realized)} USD · ${t.today.buys} Käufe, ${t.today.sells} Verkäufe${t.today.sells ? ` (${t.today.wins} Gewinn)` : ""} · Gebühren ${t.today.fees.toFixed(2)} USD`,
    `7 Tage ${sg(t.week.usd)} USD (${sg(t.week.pct)} %) · insgesamt ${sg(t.total.usd)} USD (${sg(t.total.pct)} %)`];
  if (best) lines.push(`Bester Trade: ${best.symbol} ${sg(best.pnl)} USD · schlechtester: ${worst.symbol} ${sg(worst.pnl)} USD`);
  lines.push(open.length ? `Offene Positionen (${open.length}):\n${open.join("\n")}` : "Keine offene Position über Nacht.");
  if (perf.maxDrawdownPct > 0) lines.push(`Drawdown aktuell ${perf.drawdownPct.toFixed(1)} % (maximal bisher ${perf.maxDrawdownPct.toFixed(1)} %)`);
  await makeNotifier(cfg, fetchFn).report(lines.join("\n"));
}

// Kennzahlen Heute / 7 Tage / 30 Tage / Insgesamt; für die Kopfzeile, den Profit-Tab und den Discord-Knopf
export async function getProfit(now = new Date()) {
  const acc = await getAccount(), nowMs = now.getTime();
  const log = appendEquity(await getLocal("equityLog", []), nowMs, acc.equity, 0);   // aktueller Stand zählt immer mit (wird nicht gespeichert)
  const trades = await getLocal("trades", []);
  const allTrades = await getLocal("trades", []);
  return { perf: performance(allTrades, log), strategies: byStrategy(allTrades).slice(0, 12), breaker: await getLocal("breaker", null),
    equity: acc.equity, capital: acc.capital, cash: acc.cash, periods: periodStats({ log, trades, now: nowMs, capital: acc.capital, equity: acc.equity }),
    bots: byBot(trades, nowMs, BOT_IDS), labels: Object.fromEntries(BOT_IDS.map((id) => [id, BOTS[id].label])), curve: sampleCurve(log, 300), now: now.toISOString() };
}

// Gesamtübersicht für das Dashboard „Alle“: die drei Bots mit ihrem HAUPT-Modus (keine Schatten-Läufe) zusammengefasst
export async function getOverview(now = new Date()) {
  const P = await getProfit(now), acc = await getAccount(), bots = [];
  for (const id of BOT_IDS) {
    const cfg = await loadConfig(id), st = await loadState(cfg, id);
    const positions = Object.values(st.positions).map((p) => ({ ...p, price: st.activity?.[p.symbol]?.price ?? p.entryPrice }));
    const markets = cfg.assets.map(symbolOf).map((symbol) => {
      const a = st.activity?.[symbol] || {};
      return { symbol, price: a.price ?? null, regime: a.regime ?? null, strategy: a.strategy ?? null, signal: a.signal ?? null, error: a.error ?? null, open: !!st.positions[symbol] };
    });
    bots.push({ id, label: BOTS[id].label, mode: cfg.backtest.profile, modeLabel: MODE_LABEL[cfg.backtest.profile], enabled: st.enabled, timeframe: cfg.timeframe, live: !!cfg.liveTrading, positions, markets,
      activeStrategies: st.approved.filter((a) => a.active !== false).length, approved: st.approved.length, lastTick: st.lastTick || null, lastError: st.lastError || null, halted: !!st.risk?.halted,
      paused: !!st.pauseUntil && Date.parse(st.pauseUntil) > now.getTime(), realizedToday: P.bots[id].today.realized, realizedTotal: P.bots[id].total.realized });
  }
  const trades = (await getLocal("trades", [])).filter((t) => t.action === "ENTRY" || t.action === "EXIT").slice(-40).reverse();
  return { account: acc, periods: P.periods, curve: P.curve, capital: P.capital, breaker: P.breaker, bots, trades, now: now.toISOString() };
}

// ---- Live-Statistik für Discord ---------------------------------------------------------------------------------------
export async function getLiveStats() {
  const account = await getAccount(), bots = [];
  for (const id of BOT_IDS) {
    const cfg = await loadConfig(id), st = await loadState(cfg, id);
    bots.push({ id, label: BOTS[id].label, modeLabel: MODE_LABEL[cfg.backtest.profile], enabled: st.enabled, positions: Object.values(st.positions).map((p) => ({ ...p, price: st.activity?.[p.symbol]?.price ?? p.entryPrice })) });
  }
  return { account, bots, trades: (await getLocal("trades", [])).slice(-300), profit: await getProfit(), now: new Date().toISOString() };
}

// Knöpfe: ein Bot-Zugang verbindet sich ausgehend mit Discord und beantwortet Klicks (siehe discordbot.js).
let discordBot = null, discordKey = "";
export async function syncDiscord(fetchFn = fetch, WS = globalThis.WebSocket) {
  const d = (await loadConfig()).discord, want = d.enabled && d.botToken && d.channelId && WS;
  const key = want ? `${d.botToken}|${d.channelId}` : "";
  if (key === discordKey && (!want || discordBot)) return;
  discordBot?.stop(); discordBot = null; discordKey = key;
  if (!want) return;
  discordBot = new DiscordBot({ token: d.botToken, channelId: d.channelId, getSnapshot: getLiveStats, fetchFn, WS });
  discordBot.start();
}
export const discordBotStatus = () => (discordBot ? discordBot.status() : { state: "aus", error: null });

// Eine Nachricht im Kanal (per Webhook), die sich höchstens einmal pro Minute selbst aktualisiert.
let lastLive = 0;
async function updateLiveMessage(fetchFn = fetch) {
  const d = (await loadConfig()).discord;
  if (!d.enabled || !d.webhook || !d.liveMessage || Date.now() - lastLive < 60_000) return;
  lastLive = Date.now();
  const body = JSON.stringify({ username: "Trading-Bot", content: "📌 Live – aktualisiert sich jede Minute (am besten anpinnen)", embeds: [buildStatsEmbed(await getLiveStats(), "stats")], allowed_mentions: { parse: [] } });
  const headers = { "content-type": "application/json" }, saved = await getLocal("discordLive", {}), tag = d.webhook.slice(-12);
  if (saved.id && saved.tag === tag) {
    const r = await fetchFn(`${d.webhook}/messages/${saved.id}`, { method: "PATCH", headers, body });
    if (r.ok) return;
    if (r.status !== 404) throw new Error(`Discord HTTP ${r.status}`);
  }
  const r = await fetchFn(`${d.webhook}?wait=true`, { method: "POST", headers, body });
  if (!r.ok) throw new Error(`Discord HTTP ${r.status}`);
  await setLocal("discordLive", { id: (await r.json())?.id, tag });
}

// Engine eines Bots; Paper: mit dem gemeinsamen Konto, das nach jedem Speichern mitgeschrieben wird.
function makeEngine(botId, cfg, state, account, broker, fetchFn, notify, refresher) {
  return new Engine({
    cfg, state, broker, notify, botId,
    fetchRecent: (symbol) => fetchRecent(cfg, symbol, fetchFn),
    logTrade: (row) => appendTrade({ ...row, bot: botId }),
    save: async () => { await setLocal(stateKey(cfg, botId), state); if (account) await saveAccount(account); },
    refresher,
  });
}

async function tickOnce(botId, { fetchFn = fetch, now = new Date() } = {}) {
  let cfg, state, account = null;
  try {
    cfg = await loadConfig(botId);
    state = await loadState(cfg, botId);
    if (!state.enabled && !state.killRequested) return;
    const notify = makeNotifier(cfg, fetchFn, botId);
    let broker;
    if (cfg.liveTrading) {
      const key = await getUnlockedKey();
      if (!key) {
        state.locked = true;
        await setLocal(stateKey(cfg, botId), state);
        if (Date.now() - lastNoticeAt > 30 * 60_000) {
          lastNoticeAt = Date.now();
          const open = Object.keys(state.positions).length ? " ACHTUNG: Position offen und ohne Überwachung!" : "";
          await notify(`WARNUNG: Wallet gesperrt – Bot kann nicht handeln. Bitte im Popup entsperren.${open}`);
        }
        return;
      }
      state.locked = false;
      broker = new SolanaWallet(cfg, key, fetchFn);
    } else {
      account = await loadAccount(cfg);
      broker = new PaperBroker(cfg, state, account);
    }
    const engine = makeEngine(botId, cfg, state, account, broker, fetchFn, notify, () => researchAndBacktest(cfg, fetchFn));
    await engine.tick(now);
    state.lastError = null;
    state.lastTick = now.toISOString();
    await setLocal(stateKey(cfg, botId), state);
    if (account) await saveAccount(account);
  } catch (e) {
    console.error(e);
    if (state) {
      state.lastError = `${e.message}`;
      makeNotifier(cfg, fetchFn, botId).log(`Fehler im Durchlauf: ${e.message}`, "error");
      await setLocal(stateKey(cfg, botId), state);
      if (Date.now() - lastNoticeAt > 10 * 60_000) { lastNoticeAt = Date.now(); await makeNotifier(cfg, fetchFn, botId)(`WARNUNG: Fehler im Durchlauf: ${e.message}`); }
    }
  }
}

// ---- Steuerung per Telegram (alle 30 s vom Alarm aufgerufen) ----------------------------------------------------------
export async function pollTelegram(fetchFn = fetch) {
  try {
    const cfg = await loadConfig();
    if (!cfg.telegram.enabled) return;
    await pollCommands(cfg, fetchFn, {
      getOffset: () => getLocal("tgOffset", null),
      setOffset: (n) => setLocal("tgOffset", n),
      run: async (cmd, args) => {
        try {
          if (cmd === "/status") {
            const a = await getAccount(), lines = [`Paper-Konto (gemeinsam): Eigenkapital ${a.equity.toFixed(2)} USD (${a.pnl >= 0 ? "+" : ""}${a.pnlPct.toFixed(2)} %), Bargeld ${a.cash.toFixed(2)} USD`];
            for (const id of BOT_IDS) lines.push(`— ${BOTS[id].label} —`, formatStatus(await getStatus(id)));
            return lines.join("\n");
          }
          if (cmd === "/stop") { await handle({ type: "stopAll" }, fetchFn); return "Handel aller Bots gestoppt. Offene Positionen bleiben mit ihren Stops bestehen. Starten geht nur in der App/im Browser."; }
          if (cmd === "/kill") {
            if (args[0]?.toLowerCase() !== "ja") return "NOT-AUS schließt ALLE Positionen aller Bots und stoppt sie. Zum Bestätigen schreibe:\n/kill ja";
            await handle({ type: "killAll" }, fetchFn);
            const left = [];
            for (const id of BOT_IDS) left.push(...Object.keys((await getStatus(id)).state.positions));
            return left.length ? `NOT-AUS: nicht geschlossen: ${left.join(", ")} – bitte in der App/Wallet prüfen!` : "NOT-AUS ausgeführt: keine offene Position, alle Bots gestoppt.";
          }
          return HELP; // /help, /start (Telegram-Standard) und alles Unbekannte
        } catch (e) {
          return `Fehler: ${e.message}`;
        }
      },
    });
  } catch (e) {
    console.warn("Telegram-Abfrage fehlgeschlagen:", e.message);
  }
}

// ---- Aktionen aus dem Popup --------------------------------------------------------------------------------------
const maskSecrets = (cfg) => ({ ...cfg, llm: { ...cfg.llm, apiKey: cfg.llm.apiKey ? "***" : "" }, telegram: { ...cfg.telegram, token: cfg.telegram.token ? "***" : "" },
  discord: { ...cfg.discord, webhook: cfg.discord.webhook ? "***" : "", botToken: cfg.discord.botToken ? "***" : "", logWebhook: cfg.discord.logWebhook ? "***" : "" } });

const ownRow = (botId) => (t) => (t.bot || DEFAULT_BOT) === botId;

export async function getStatus(botId = DEFAULT_BOT) {
  const cfg = await loadConfig(botId), state = await loadState(cfg, botId);
  const safeCfg = maskSecrets(cfg);
  const account = cfg.liveTrading ? null : await loadAccount(cfg);
  return {
    bot: botId, botLabel: BOTS[botId].label,
    cfg: safeCfg,
    state: { enabled: state.enabled, killRequested: !!state.killRequested, locked: !!state.locked, pending: state.pending || null,
      positions: state.positions, risk: state.risk || {}, paperCash: account ? account.cash : (state.paper?.cash ?? null), approved: state.approved,
      report: state.report, problems: state.problems || [], activity: state.activity || {}, decisions: (state.decisions || []).slice(-10).reverse(), status: state.status || null, lastRefresh: state.lastRefresh || null, lastTick: state.lastTick || null, lastError: state.lastError || null },
    vault: { exists: await hasVault(), address: await vaultAddress(), unlocked: !!(await getUnlockedKey()) },
    trades: (await getLocal("trades", [])).filter(ownRow(botId)).slice(-50).reverse(),
    events: (await getLocal("eventLog", [])).filter(ownRow(botId)).slice(-30).reverse(),
  };
}

// Das gemeinsame Paper-Konto und die Lage der drei Bots (für die Kopfzeile der App).
export async function getAccount() {
  const main = await loadConfig(), acc = await loadAccount(main);
  const bots = [];
  let held = 0;
  for (const id of BOT_IDS) {
    const cfg = await loadConfig(id), st = await loadState(cfg, id);
    const own = Object.values(st.positions).reduce((x, p) => x + p.amount * (st.activity?.[p.symbol]?.price ?? p.entryPrice), 0);
    const value = id === DEFAULT_BOT && main.liveTrading ? 0 : own; // Live-Krypto liegt in der Wallet, nicht im Paper-Konto
    held += value;
    bots.push({ id, label: BOTS[id].label, enabled: st.enabled, positions: Object.keys(st.positions).length, value, killRequested: !!st.killRequested,
      pending: !!st.pending, locked: !!st.locked, lastTick: st.lastTick || null, lastError: st.lastError || null, live: id === DEFAULT_BOT && main.liveTrading,
      halted: !!st.risk?.halted, approvedActive: st.approved.filter((a) => a.active).length });
  }
  const equity = acc.cash + held;
  return { capital: main.capital.start, cash: acc.cash, held, equity, pnl: equity - main.capital.start, pnlPct: (equity / main.capital.start - 1) * 100, bots };
}

// Aktionen aus der Oberfläche landen (ohne Geheimnisse) im Protokoll-Kanal; danach werden gesammelte Logzeilen gesendet.
const LOGGED = { start: "Bot gestartet", stop: "Bot gestoppt", kill: "NOT-AUS ausgelöst", killAll: "NOT-AUS für alle Bots ausgelöst", startAll: "Alle Bots gestartet", stopAll: "Alle Bots gestoppt",
  research: "Strategien wurden neu geprüft", resetAccount: "Paper-Konto zurückgesetzt", saveConfig: "Einstellungen gespeichert", testTrade: "Testtrade ausgelöst" };

export async function handle(msg, fetchFn = fetch) {
  try {
    const result = await handleInner(msg, fetchFn);
    if (LOGGED[msg.type]) {
      const cfg = await loadConfig(botOf(msg));
      makeNotifier(cfg, fetchFn, botOf(msg)).log(`${LOGGED[msg.type]}${msg.type === "saveConfig" ? ` (geändert: ${Object.keys(msg.patch || {}).join(", ") || "–"})` : ""}`, /kill/i.test(msg.type) ? "warn" : "info");
    }
    return result;
  } catch (e) {
    if (LOGGED[msg?.type] || ["buy", "sell", "adjust"].includes(msg?.type)) {
      const cfg = await loadConfig(botOf(msg)).catch(() => null);
      if (cfg) makeNotifier(cfg, fetchFn, botOf(msg)).log(`Aktion „${msg.type}“ abgelehnt: ${e.message}`, "warn");
    }
    throw e;
  } finally {
    await flushLogs(fetchFn);
  }
}

async function handleInner(msg, fetchFn = fetch) {
  const botId = botOf(msg);
  const cfg = await loadConfig(botId);
  switch (msg.type) {
    case "getStatus": return getStatus(botId);
    case "getAccount": return { ...(await getAccount()), today: (await getProfit()).periods.today };
    case "getProfit": return getProfit();
    case "getModes": return getModes();
    case "getOverview": return getOverview();
    case "getModeDetail": return getModeDetail(botId, MODE_IDS.includes(msg.mode) ? msg.mode : cfg.backtest.profile);
    case "resetShadows": {   // Schatten-Läufe auf Anfang (frisches Paper-Geld, keine Trades) – für einen sauberen Neustart des Vergleichs
      for (const id of BOT_IDS) for (const m of MODE_IDS) { const k = shadowKeys(id, m); for (const key of Object.values(k)) await removeLocal(key); }
      await setLocal("logMarks", {});
      return true;
    }
    case "exportTrades": return { csv: tradesToCsv((await getLocal("trades", [])).slice(-1000)), count: Math.min(1000, (await getLocal("trades", [])).length) };
    case "clearBreaker": { await setLocal("breaker", null); await setLocal("equityPeak", (await getAccount()).equity); return true; }
    case "saveConfig": { const r = await saveConfig(msg.patch, botId); await syncDiscord(fetchFn).catch(() => {}); return r; }
    case "getLiveStats": return getLiveStats();
    case "discordStatus": return discordBotStatus();
    case "postDiscordPanel": {
      if (!cfg.discord.botToken || !cfg.discord.channelId) throw new Error("Bot-Token und Kanal-ID eintragen und speichern.");
      await postPanel(cfg.discord.botToken, cfg.discord.channelId, await getLiveStats(), fetchFn);
      await syncDiscord(fetchFn);
      return true;
    }
    case "getConfig": return maskSecrets(cfg);
    case "testDiscord": {
      if (!cfg.discord.webhook) throw new Error("Kein Discord-Webhook eingetragen (zuerst speichern).");
      await sendDiscord(cfg.discord.webhook, "✅ Trading-Bot: Discord-Verbindung funktioniert. Hier kommen Käufe/Verkäufe (mit Stop, Ziel und Begründung) und jede Stunde ein Bericht, warum gekauft oder nicht gekauft wurde.", fetchFn);
      return true;
    }
    case "testDiscordLog": {
      if (!cfg.discord.logWebhook) throw new Error("Kein Log-Webhook eingetragen (zuerst speichern).");
      await sendDiscord(cfg.discord.logWebhook, "📜 Trading-Bot: Log-Webhook funktioniert. Hier erscheinen Entscheidungen je Kerze, Handel, Fehler und Aktionen aus der App.", fetchFn, "Trading-Bot Log");
      return true;
    }
    case "startAll": { for (const id of BOT_IDS) await handle({ type: "start", bot: id }, fetchFn).catch(() => {}); return true; }
    case "stopAll": { for (const id of BOT_IDS) await handle({ type: "stop", bot: id }, fetchFn); return true; }
    case "killAll": {
      for (const id of BOT_IDS) { const c = await loadConfig(id), st = await loadState(c, id); st.killRequested = true; await setLocal(stateKey(c, id), st); }
      await whenIdle();
      await runTick({ fetchFn });
      return true;
    }
    case "resetAccount": { // Paper-Konto auf das Startkapital zurücksetzen (nur ohne offene Positionen)
      for (const id of BOT_IDS) { const c = await loadConfig(id); if (Object.keys((await loadState(c, id)).positions).length) throw new Error("Zurücksetzen nur ohne offene Positionen."); }
      await saveAccount({ cash: cfg.capital.start, values: {} });
      await setLocal("equityPeak", cfg.capital.start); await setLocal("breaker", null); await setLocal("equityLog", []);
      return true;
    }
    case "start": {
      if (cfg.liveTrading && !(await getUnlockedKey())) throw new Error("Wallet zuerst entsperren.");
      const st = await loadState(cfg, botId);
      if (st.killRequested) throw new Error("Not-Aus ist noch aktiv – Position erst schließen/prüfen.");
      if (await getLocal("breaker", null)) { await setLocal("breaker", null); await setLocal("equityPeak", (await getAccount()).equity); }   // bewusster Neustart nach der Notbremse: neuer Höchststand
      st.enabled = true;
      await setLocal(stateKey(cfg, botId), st);
      runTick({ fetchFn }); // im Hintergrund, blockiert das Popup nicht
      return true;
    }
    case "testTrade": {
      if (cfg.liveTrading) throw new Error("Testtrade ist nur im Paper-Modus erlaubt.");
      await whenIdle();
      const state = await loadState(cfg, botId), account = await loadAccount(cfg);
      const engine = makeEngine(botId, cfg, state, account, new PaperBroker(cfg, state, account), fetchFn, makeNotifier(cfg, fetchFn, botId),
        async () => { throw new Error("nicht benötigt"); });
      const sym = await engine.testEntry(new Date());
      await setLocal(stateKey(cfg, botId), state);
      await saveAccount(account);
      return sym;
    }
    case "chart": { // Daten für das Dashboard: Kerzen, Durchschnitte, Position, Aktivität
      const st = await loadState(cfg, botId);
      const sym = msg.symbol || Object.keys(st.positions)[0] || symbolOf(cfg.assets[0]);
      const df = await fetchRecent(cfg, sym, fetchFn), n = df.t.length, from = Math.max(0, n - (msg.bars || 160));
      const e20 = ema(df.close, 20), e50 = ema(df.close, 50), cut = (a) => a.slice(from);
      return { symbol: sym, timeframe: cfg.timeframe, t: cut(df.t), open: cut(df.open), high: cut(df.high), low: cut(df.low), close: cut(df.close),
        ema20: cut(e20), ema50: cut(e50), position: st.positions[sym] || null, positions: st.positions, activity: st.activity || {},
        decisions: (st.decisions || []).slice(-15).reverse(), symbols: cfg.assets.map(symbolOf), enabled: st.enabled, paper: !cfg.liveTrading,
        trades: (await getLocal("trades", [])).filter((t) => t.symbol === sym).slice(-30),
        risk: st.risk || {}, cash: cfg.liveTrading ? null : (await loadAccount(cfg)).cash, trail: cfg.trail, manualBuy: !cfg.liveTrading,
        costs: cfg.costs, maxPositionPct: cfg.risk.maxPositionPct, riskPerTradePct: cfg.risk.riskPerTradePct, maxPositions: cfg.risk.maxOpenPositions };
    }
    case "buy": case "sell": case "adjust": { // Handeln im Dashboard: Kauf (nur Paper), Verkauf, Stop-Loss/Take-Profit/Trailing einer offenen Position ändern
      await whenIdle();
      const state = await loadState(cfg, botId), account = cfg.liveTrading ? null : await loadAccount(cfg);
      let broker = null;
      if (!cfg.liveTrading) broker = new PaperBroker(cfg, state, account);
      else if (msg.type === "sell") {
        const key = await getUnlockedKey();
        if (!key) throw new Error("Wallet zuerst entsperren.");
        broker = new SolanaWallet(cfg, key, fetchFn);
      } else if (msg.type === "buy") throw new Error("Manueller Kauf ist nur im Paper-Modus erlaubt.");
      else broker = { mode: "live", cash: async () => 0 }; // Stop/Ziel ändern braucht kein Konto: nur der Bot überwacht sie
      const engine = makeEngine(botId, cfg, state, account, broker, fetchFn, makeNotifier(cfg, fetchFn, botId), async () => { throw new Error("nicht benötigt"); });
      const num = (x) => (x === "" || x == null ? undefined : Number(x));
      for (const k of ["usd", "stop", "takeProfit"]) if (msg[k] != null && msg[k] !== "" && !(Number(msg[k]) > 0)) throw new Error("Zahlen müssen größer 0 sein.");
      const sym = String(msg.symbol || "");
      const text = msg.type === "buy" ? await engine.manualBuy(sym, { usd: num(msg.usd), stop: num(msg.stop), takeProfit: num(msg.takeProfit) })
        : msg.type === "sell" ? await engine.manualSell(sym)
        : await engine.adjustPosition(sym, { stop: num(msg.stop), takeProfit: num(msg.takeProfit), trailOff: msg.trailOff });
      await setLocal(stateKey(cfg, botId), state);
      if (account) await saveAccount(account);
      return text;
    }
    case "tickNow": await whenIdle(); await runTick({ fetchFn }); return true;
    case "stop": { const st = await loadState(cfg, botId); st.enabled = false; await setLocal(stateKey(cfg, botId), st); return true; }
    case "kill": {
      const st = await loadState(cfg, botId);
      st.killRequested = true;
      await setLocal(stateKey(cfg, botId), st);
      await whenIdle(); // einen gerade laufenden Durchlauf abwarten, dann sofort den Not-Aus ausführen
      await runTick({ fetchFn });
      return true;
    }
    case "clearKill": { const st = await loadState(cfg, botId); st.killRequested = false; await setLocal(stateKey(cfg, botId), st); return true; }
    case "clearPending": { const st = await loadState(cfg, botId); st.pending = null; await setLocal(stateKey(cfg, botId), st); return true; }
    case "research": {
      const res = await researchAndBacktest(cfg, fetchFn);
      const st = await loadState(cfg, botId);
      Object.assign(st, { approved: res.approved, report: res.report, problems: res.problems || [], lastRefresh: new Date().toISOString() });
      await setLocal(stateKey(cfg, botId), st);
      const d = summarizeFailures(res.report);
      return { approved: res.approved.length, active: res.approved.filter((a) => a.active).length, tested: res.report.length, candles: res.candles,
        problems: res.problems, markets: [...new Set(res.report.map((r) => r.symbol))].length, topReasons: d.byReason.slice(0, 3), profitable: d.profitable, highWin: d.highWin };
    }
    case "balances": {
      const address = await vaultAddress();
      if (!address) throw new Error("Keine Wallet vorhanden.");
      const w = new SolanaWallet(cfg, null, fetchFn, address);
      return { address, sol: await w.solBalance(), usdc: await w.usdcBalance() };
    }
    // ---- Wallet ----
    case "createWallet": {
      if (await hasVault()) throw new Error("Es existiert bereits eine Wallet. Zuerst Backup prüfen und löschen.");
      const kp = generateKeypair();
      await createVault(msg.password, kp.secretKey, kp.address);
      return { address: kp.address, backupKey: b58encode(kp.secretKey) };
    }
    case "importWallet": {
      if (await hasVault()) throw new Error("Es existiert bereits eine Wallet.");
      const kp = parseSecretKey(msg.key);
      await createVault(msg.password, kp.secretKey, kp.address);
      return { address: kp.address };
    }
    case "unlock": await unlock(msg.password); return true;
    case "lock": await lock(); return true;
    case "exportKey": return b58encode(await decryptVault(msg.password));
    case "deleteWallet": {
      await decryptVault(msg.password); // Passwort nötig
      const st = await loadState({ liveTrading: true });
      if (Object.keys(st.positions).length) throw new Error("Wallet mit offener Position kann nicht gelöscht werden.");
      await deleteVault();
      return true;
    }
    default: throw new Error(`Unbekannte Aktion: ${msg.type}`);
  }
}

