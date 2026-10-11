// Service Worker: führt alle 30 Sekunden einen Bot-Durchlauf aus und beantwortet Anfragen des Popups.
import { handle, runTick, pollTelegram, loadConfig, loadState } from "./lib/controller.js";

async function ensureAlarm() {
  if (!(await chrome.alarms.get("tick"))) chrome.alarms.create("tick", { periodInMinutes: 0.5 });
}

async function updateBadge() {
  try {
    const cfg = await loadConfig(), st = await loadState(cfg);
    const text = st.pending ? "!" : st.locked ? "LOCK" : st.killRequested ? "KILL" : st.enabled ? (cfg.liveTrading ? "LIVE" : "ON") : "";
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: st.pending || st.locked || st.killRequested ? "#c0392b" : cfg.liveTrading ? "#b9770e" : "#2e7d32" });
  } catch (e) { console.error(e); }
}

chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
ensureAlarm();

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "tick") return;
  await pollTelegram();
  await runTick();
  await updateBadge();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false; // nur eigene Extension-Seiten
  handle(msg).then(async (result) => { await updateBadge(); sendResponse({ ok: true, result }); },
    (e) => sendResponse({ ok: false, error: e.message }));
  return true;
});
