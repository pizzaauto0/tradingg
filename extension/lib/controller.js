// Steuerung: Konfiguration, Zustand, Durchlauf (Tick) und alle Aktionen, die das Popup auslösen kann.
import { DEFAULTS, mergeConfig, validateConfig } from "./config.js";
import { getLocal, setLocal, appendTrade } from "./store.js";
import { Engine } from "./engine.js";
import { fetchRecent } from "./data.js";
import { researchAndBacktest } from "./pipeline.js";
import { PaperBroker, SolanaWallet, generateKeypair, parseSecretKey } from "./solana.js";
import { createVault, decryptVault, deleteVault, getUnlockedKey, hasVault, lock, unlock, vaultAddress } from "./vault.js";
import { b58encode } from "./util.js";
import { summarizeFailures } from "./diagnose.js";

let current = null; // laufender Durchlauf (Promise) – es läuft nie mehr als einer gleichzeitig
export async function whenIdle() { while (current) await current; }

export async function loadConfig() { return validateConfig(mergeConfig(DEFAULTS, await getLocal("config", {}))); }
const stateKey = (cfg) => `botState_${cfg.liveTrading ? "live" : "paper"}`;
const defaultState = () => ({ enabled: false, approved: [], report: [], positions: {} });
export async function loadState(cfg) { return { ...defaultState(), ...(await getLocal(stateKey(cfg), {})) }; }

export async function saveConfig(patch) {
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
async function pushLog(text) {
  const log = await getLocal("eventLog", []);
  log.push({ ts: new Date().toISOString(), text });
  await setLocal("eventLog", log.slice(-100));
}

export function makeNotifier(cfg, fetchFn = fetch) {
  return async (text) => {
    console.info("NOTIFY:", text);
    await pushLog(text);
    if (/^(WARNUNG|NOT-AUS|ENTRY|EXIT|Tagesverlust)/.test(text) && globalThis.chrome?.notifications) {
      chrome.notifications.create({ type: "basic", iconUrl: "icons/icon128.png", title: `Trading-Bot [${cfg.liveTrading ? "LIVE" : "PAPER"}]`, message: text.slice(0, 250) });
    }
    if (cfg.telegram.enabled && cfg.telegram.token && cfg.telegram.chatId) {
      try {
        await fetchFn(`https://api.telegram.org/bot${cfg.telegram.token}/sendMessage`, { method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: cfg.telegram.chatId, text: `[${cfg.liveTrading ? "LIVE" : "PAPER"}] ${text}`.slice(0, 4000) }) });
      } catch { /* Telegram-Fehler dürfen den Bot nie stoppen */ }
    }
  };
}

// ---- Ein Durchlauf (vom Alarm alle 30 s aufgerufen) ----------------------------------------------------------------
export function runTick(opts = {}) {
  if (current) return current.then(() => {}, () => {}); // läuft schon einer: dieser Aufruf wird übersprungen
  current = tickOnce(opts).finally(() => { current = null; });
  return current;
}

async function tickOnce({ fetchFn = fetch, now = new Date() } = {}) {
  let cfg, state;
  try {
    cfg = await loadConfig();
    state = await loadState(cfg);
    if (!state.enabled && !state.killRequested) return;
    const notify = makeNotifier(cfg, fetchFn);
    let broker;
    if (cfg.liveTrading) {
      const key = await getUnlockedKey();
      if (!key) {
        state.locked = true;
        await setLocal(stateKey(cfg), state);
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
      broker = new PaperBroker(cfg, state);
    }
    const engine = new Engine({
      cfg, state, broker, notify,
      fetchRecent: (symbol) => fetchRecent(cfg, symbol, fetchFn),
      logTrade: appendTrade,
      save: () => setLocal(stateKey(cfg), state),
      refresher: () => researchAndBacktest(cfg, fetchFn),
    });
    await engine.tick(now);
    state.lastError = null;
    state.lastTick = now.toISOString();
    await setLocal(stateKey(cfg), state);
  } catch (e) {
    console.error(e);
    if (state) {
      state.lastError = `${e.message}`;
      await setLocal(stateKey(cfg), state);
      if (Date.now() - lastNoticeAt > 10 * 60_000) { lastNoticeAt = Date.now(); await makeNotifier(cfg, fetchFn)(`WARNUNG: Fehler im Durchlauf: ${e.message}`); }
    }
  }
}

// ---- Aktionen aus dem Popup --------------------------------------------------------------------------------------
const maskSecrets = (cfg) => ({ ...cfg, llm: { ...cfg.llm, apiKey: cfg.llm.apiKey ? "***" : "" }, telegram: { ...cfg.telegram, token: cfg.telegram.token ? "***" : "" } });

export async function getStatus() {
  const cfg = await loadConfig(), state = await loadState(cfg);
  const safeCfg = maskSecrets(cfg);
  return {
    cfg: safeCfg,
    state: { enabled: state.enabled, killRequested: !!state.killRequested, locked: !!state.locked, pending: state.pending || null,
      positions: state.positions, risk: state.risk || {}, paperCash: state.paper?.cash ?? null, approved: state.approved,
      report: state.report, problems: state.problems || [], activity: state.activity || {}, decisions: (state.decisions || []).slice(-10).reverse(), status: state.status || null, lastRefresh: state.lastRefresh || null, lastTick: state.lastTick || null, lastError: state.lastError || null },
    vault: { exists: await hasVault(), address: await vaultAddress(), unlocked: !!(await getUnlockedKey()) },
    trades: (await getLocal("trades", [])).slice(-50).reverse(),
    events: (await getLocal("eventLog", [])).slice(-30).reverse(),
  };
}

export async function handle(msg, fetchFn = fetch) {
  const cfg = await loadConfig();
  switch (msg.type) {
    case "getStatus": return getStatus();
    case "saveConfig": return saveConfig(msg.patch);
    case "getConfig": return maskSecrets(cfg);
    case "start": {
      if (cfg.liveTrading && !(await getUnlockedKey())) throw new Error("Wallet zuerst entsperren.");
      const st = await loadState(cfg);
      if (st.killRequested) throw new Error("Not-Aus ist noch aktiv – Position erst schließen/prüfen.");
      st.enabled = true;
      await setLocal(stateKey(cfg), st);
      runTick({ fetchFn }); // im Hintergrund, blockiert das Popup nicht
      return true;
    }
    case "tickNow": await whenIdle(); await runTick({ fetchFn }); return true;
    case "stop": { const st = await loadState(cfg); st.enabled = false; await setLocal(stateKey(cfg), st); return true; }
    case "kill": {
      const st = await loadState(cfg);
      st.killRequested = true;
      await setLocal(stateKey(cfg), st);
      await whenIdle(); // einen gerade laufenden Durchlauf abwarten, dann sofort den Not-Aus ausführen
      await runTick({ fetchFn });
      return true;
    }
    case "clearKill": { const st = await loadState(cfg); st.killRequested = false; await setLocal(stateKey(cfg), st); return true; }
    case "clearPending": { const st = await loadState(cfg); st.pending = null; await setLocal(stateKey(cfg), st); return true; }
    case "research": {
      const res = await researchAndBacktest(cfg, fetchFn);
      const st = await loadState(cfg);
      Object.assign(st, { approved: res.approved, report: res.report, problems: res.problems || [], lastRefresh: new Date().toISOString() });
      await setLocal(stateKey(cfg), st);
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

