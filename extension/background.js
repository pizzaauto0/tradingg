// Service Worker: führt alle 30 Sekunden einen Bot-Durchlauf aus und beantwortet Anfragen des Popups.
import { handle, runTick, pollTelegram, loadConfig, loadState } from "./lib/controller.js";
import { BOT_IDS } from "./lib/config.js";

async function ensureAlarm() {
  if (!(await chrome.alarms.get("tick"))) chrome.alarms.create("tick", { periodInMinutes: 0.5 });
}

async function updateBadge() {
  try {
    const all = [];
    for (const id of BOT_IDS) { const cfg = await loadConfig(id); all.push([cfg, await loadState(cfg, id)]); }
    const any = (f) => all.some(([c, s]) => f(c, s));
    const text = any((c, s) => s.pending) ? "!" : any((c, s) => s.locked) ? "LOCK" : any((c, s) => s.killRequested) ? "KILL"
      : any((c, s) => s.enabled && c.liveTrading) ? "LIVE" : any((c, s) => s.enabled) ? "ON" : "";
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: any((c, s) => s.pending || s.locked || s.killRequested) ? "#c0392b" : any((c) => c.liveTrading) ? "#b9770e" : "#2e7d32" });
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
