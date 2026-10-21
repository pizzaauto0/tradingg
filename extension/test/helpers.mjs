// Test-Hilfen: simuliertes chrome.storage und simulierte Marktdaten-APIs.
export function installFakeChrome() {
  const mk = () => { const m = new Map(); return {
    async get(key) { return key == null ? Object.fromEntries(m) : m.has(key) ? { [key]: structuredClone(m.get(key)) } : {}; },
    async set(obj) { for (const [k, v] of Object.entries(obj)) m.set(k, structuredClone(v)); },
    async remove(key) { m.delete(key); }, _m: m }; };
  globalThis.chrome = { storage: { local: mk(), session: mk() }, notifications: { create() {} } };
  // Die Testdaten haben winzige Kursbewegungen (Ziel nur ~1 % entfernt, Kosten 0,9 %): der Kosten-Filter (minRewardToCost) wäre dort immer aktiv.
  // Tests, die ihn prüfen, setzen ihn selbst wieder auf 2.
  const off = { risk: { minRewardToCost: 0 } };
  for (const k of ["config", "config_fx", "config_metals"]) globalThis.chrome.storage.local._m.set(k, structuredClone(off));
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

// fetch-Attrappe für Kraken (Live-Kerzen), Bitstamp und Coinbase (Historie). world.df = nur SOL, world.dfs = { "BTC/USD": df, … }.
// Märkte ohne Eintrag in world.dfs antworten wie unbekannte Paare (Kraken: Fehlermeldung, Bitstamp/Coinbase: 404).
import { ASSETS } from "../lib/config.js";
const bySource = (key) => Object.fromEntries(Object.values(ASSETS).filter((a) => a[key]).map((a) => [a[key], a.symbol]));
const KR = bySource("kraken"), BS = bySource("bitstamp"), CB = bySource("coinbase");
const YH = Object.fromEntries(Object.values(ASSETS).filter((a) => a.yahoo && !a.invert).map((a) => [a.yahoo, a.symbol]));
export function marketFetch(world) {
  const json = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
  const notFound = { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  const frame = (sym) => (world.dfs ? world.dfs[sym] : sym === "SOL/USD" ? world.df : undefined);
  world.calls = world.calls || [];
  return async (url) => {
    const u = new URL(url);
    world.calls.push(u.host + u.pathname);
    if (u.host === "api.kraken.com") {
      const pair = u.searchParams.get("pair"), df = frame(KR[pair]);
      if (!df) return json({ error: ["EQuery:Unknown asset pair"], result: {} });
      const n = df.t.length, from = Math.max(0, n - 720);
      const rows = df.t.slice(from).map((t, k) => { const i = from + k; return [t / 1000, String(df.open[i]), String(df.high[i]), String(df.low[i]), String(df.close[i]), "0", String(df.volume[i]), 1]; });
      return json({ error: [], result: { [pair]: rows, last: 0 } });
    }
    if (u.host === "www.bitstamp.net") {
      const df = frame(BS[u.pathname.split("/")[4]]);
      if (!df) return notFound;
      const start = +u.searchParams.get("start") * 1000, end = +u.searchParams.get("end") * 1000, ohlc = [];
      for (let i = 0; i < df.t.length; i++) if (df.t[i] >= start && df.t[i] <= end) ohlc.push({ timestamp: String(df.t[i] / 1000), open: String(df.open[i]), high: String(df.high[i]), low: String(df.low[i]), close: String(df.close[i]), volume: String(df.volume[i]) });
      return json({ data: { pair: "x", ohlc: ohlc.slice(-1000) } });
    }
    if (u.host === "api.exchange.coinbase.com") {
      const df = frame(CB[u.pathname.split("/")[2]]);
      if (!df) return notFound;
      const start = Date.parse(u.searchParams.get("start")), end = Date.parse(u.searchParams.get("end")), rows = [];
      for (let i = df.t.length - 1; i >= 0 && rows.length < 300; i--) if (df.t[i] >= start && df.t[i] < end) rows.push([df.t[i] / 1000, df.low[i], df.high[i], df.open[i], df.close[i], df.volume[i]]);
      return json(rows);
    }
    if (u.host === "query1.finance.yahoo.com") {   // Währungen/Metalle: world.dfs["EUR/USD"] usw.; Lücken-Test über world.gaps (Indizes mit null)
      const df = frame(YH[decodeURIComponent(u.pathname.split("/")[4])]);
      if (!df) return json({ chart: { result: null, error: { description: "No data found, symbol may be delisted" } } });
      const gap = new Set(world.gaps || []), pick = (a) => a.map((x, i) => (gap.has(i) ? null : x));
      return json({ chart: { result: [{ timestamp: df.t.map((t) => t / 1000), indicators: { quote: [{ open: pick(df.open), high: pick(df.high), low: pick(df.low), close: pick(df.close), volume: df.volume }] } }], error: null } });
    }
    throw new Error(`unerwartete URL ${url}`);
  };
}
