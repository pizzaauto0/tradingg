// Dünne Hülle um chrome.storage (local = dauerhaft, session = bis zum Schließen des Browsers).
const area = (name) => globalThis.chrome.storage[name];

export async function getLocal(key, def = null) {
  const r = await area("local").get(key);
  return r[key] === undefined ? def : r[key];
}
export const setLocal = (key, value) => area("local").set({ [key]: value });
export const removeLocal = (key) => area("local").remove(key);

export async function getSession(key, def = null) {
  const r = await area("session").get(key);
  return r[key] === undefined ? def : r[key];
}
export const setSession = (key, value) => area("session").set({ [key]: value });
export const removeSession = (key) => area("session").remove(key);

const MAX_TRADES = 1000;

// Trade-Protokoll mit Begründung (neueste zuletzt).
export async function appendTrade(row) {
  const trades = await getLocal("trades", []);
  trades.push(row);
  await setLocal("trades", trades.slice(-MAX_TRADES));
}
