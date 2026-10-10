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

// fetch-Attrappe für Kraken (Live-Kerzen) und Bitstamp (Historie). world.df = nur SOL, world.dfs = { "BTC/USD": df, … }.
const KR = { SOLUSD: "SOL/USD", XBTUSD: "BTC/USD", ETHUSD: "ETH/USD" }, BS = { solusd: "SOL/USD", btcusd: "BTC/USD", ethusd: "ETH/USD" };
export function marketFetch(world) {
  const json = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
  const frame = (sym) => (world.dfs ? world.dfs[sym] : sym === "SOL/USD" ? world.df : undefined);
  return async (url) => {
    const u = new URL(url);
    if (u.host === "api.kraken.com") {
      const df = frame(KR[u.searchParams.get("pair")]);
      if (!df) return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
      const n = df.t.length, from = Math.max(0, n - 720);
      const rows = df.t.slice(from).map((t, k) => { const i = from + k; return [t / 1000, String(df.open[i]), String(df.high[i]), String(df.low[i]), String(df.close[i]), "0", String(df.volume[i]), 1]; });
      return json({ error: [], result: { [u.searchParams.get("pair")]: rows, last: 0 } });
    }
    if (u.host === "www.bitstamp.net") {
      const df = frame(BS[u.pathname.split("/")[4]]);
      if (!df) return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
      const start = +u.searchParams.get("start") * 1000, end = +u.searchParams.get("end") * 1000, ohlc = [];
      for (let i = 0; i < df.t.length; i++) if (df.t[i] >= start && df.t[i] <= end) ohlc.push({ timestamp: String(df.t[i] / 1000), open: String(df.open[i]), high: String(df.high[i]), low: String(df.low[i]), close: String(df.close[i]), volume: String(df.volume[i]) });
      return json({ data: { pair: "x", ohlc: ohlc.slice(-1000) } });
    }
    throw new Error(`unerwartete URL ${url}`);
  };
}
