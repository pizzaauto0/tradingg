// Test-Hilfen: simuliertes chrome.storage und simulierte Marktdaten-APIs.
export function installFakeChrome() {
  const mk = () => { const m = new Map(); return {
    async get(key) { return key == null ? Object.fromEntries(m) : m.has(key) ? { [key]: structuredClone(m.get(key)) } : {}; },
    async set(obj) { for (const [k, v] of Object.entries(obj)) m.set(k, structuredClone(v)); },
    async remove(key) { m.delete(key); }, _m: m }; };
  globalThis.chrome = { storage: { local: mk(), session: mk() }, notifications: { create() {} } };
  return globalThis.chrome;
}

export const TF_MS = 15 * 60_000;

// Aufwärtstrend mit Rauschen; letzte geschlossene Kerze endet bei lastT.
export function makeCandles(n, lastT, f = (i) => 100 + 0.12 * i + Math.sin(i / 3) * 0.1) {
  const df = { t: [], open: [], high: [], low: [], close: [], volume: [] };
  for (let i = 0; i < n; i++) {
    const c = f(i), o = i ? df.close[i - 1] : c;
    df.t.push(lastT - (n - 1 - i) * TF_MS); df.open.push(o); df.close.push(c);
    df.high.push(Math.max(o, c) + 0.05); df.low.push(Math.min(o, c) - 0.05); df.volume.push(100 + (i % 7));
  }
  return df;
}

// fetch-Attrappe für Kraken (Live-Kerzen) und Bitstamp (Historie); `world.df` darf sich ändern.
export function marketFetch(world) {
  const json = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
  return async (url) => {
    const u = new URL(url), df = world.df, n = df.t.length;
    if (u.host === "api.kraken.com") {
      const from = Math.max(0, n - 720);
      const rows = df.t.slice(from).map((t, k) => { const i = from + k; return [t / 1000, String(df.open[i]), String(df.high[i]), String(df.low[i]), String(df.close[i]), "0", String(df.volume[i]), 1]; });
      return json({ error: [], result: { SOLUSD: rows, last: 0 } });
    }
    if (u.host === "www.bitstamp.net") {
      const start = +u.searchParams.get("start") * 1000, end = +u.searchParams.get("end") * 1000, ohlc = [];
      for (let i = 0; i < n; i++) if (df.t[i] >= start && df.t[i] <= end) ohlc.push({ timestamp: String(df.t[i] / 1000), open: String(df.open[i]), high: String(df.high[i]), low: String(df.low[i]), close: String(df.close[i]), volume: String(df.volume[i]) });
      return json({ data: { pair: "SOL/USD", ohlc: ohlc.slice(-1000) } });
    }
    throw new Error(`unerwartete URL ${url}`);
  };
}
