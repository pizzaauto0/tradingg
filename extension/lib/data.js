// Marktdaten (öffentliche REST-APIs, keine Schlüssel) je Asset: Kraken für Live-Kerzen, Bitstamp (Fallback Kraken) für die Historie.
// Kerzen-Format: { t: [ms], open: [], high: [], low: [], close: [], volume: [] }
import { sleep, timeframeSeconds } from "./util.js";
import { ASSETS, baseOf } from "./config.js";

const KRAKEN_INTERVAL = { "5m": 5, "15m": 15, "30m": 30, "1h": 60 };

export const emptyFrame = () => ({ t: [], open: [], high: [], low: [], close: [], volume: [] });

export function rowsToFrame(rows) {
  const byT = new Map(rows.map((r) => [r.t, r]));
  const sorted = [...byT.values()].sort((a, b) => a.t - b.t);
  const df = emptyFrame();
  for (const r of sorted) {
    df.t.push(r.t); df.open.push(r.o); df.high.push(r.h); df.low.push(r.l); df.close.push(r.c); df.volume.push(r.v);
  }
  return df;
}

async function getJson(fetchFn, url) {
  const resp = await fetchFn(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} von ${new URL(url).host}`);
  return resp.json();
}

// Letzte ~720 Kerzen; die letzte kann noch in Bildung sein.
export async function fetchRecent(cfg, symbol, fetchFn = fetch) {
  const body = await getJson(fetchFn, `https://api.kraken.com/0/public/OHLC?pair=${ASSETS[baseOf(symbol)].kraken}&interval=${KRAKEN_INTERVAL[cfg.timeframe]}`);
  if (body.error?.length) throw new Error(`Kraken: ${body.error.join(", ")}`);
  const key = Object.keys(body.result).find((k) => k !== "last");
  const df = rowsToFrame(body.result[key].map((r) => ({ t: r[0] * 1000, o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[6] })));
  if (df.close.length < 150) throw new Error("Zu wenige Kerzen von Kraken erhalten");
  return df;
}

async function bitstampHistory(cfg, symbol, n, fetchFn) {
  const step = timeframeSeconds(cfg.timeframe);
  let end = Math.floor(Date.now() / 1000), rows = [], empty = 0;
  while (rows.length < n && empty < 2) {
    const start = end - 1000 * step;
    const body = await getJson(fetchFn, `https://www.bitstamp.net/api/v2/ohlc/${ASSETS[baseOf(symbol)].bitstamp}/?step=${step}&limit=1000&start=${start}&end=${end}`);
    const page = (body?.data?.ohlc ?? []).map((k) => ({ t: +k.timestamp * 1000, o: +k.open, h: +k.high, l: +k.low, c: +k.close, v: +k.volume }));
    empty = page.length ? 0 : empty + 1;
    rows = rows.concat(page);
    end = start - 1;
  }
  return rows;
}

// Coinbase Exchange (öffentlich): max. 300 Kerzen je Abfrage, Granularitäten 1/5/15 Minuten, 1 Stunde.
async function coinbaseHistory(cfg, symbol, n, fetchFn) {
  const product = ASSETS[baseOf(symbol)].coinbase, step = timeframeSeconds(cfg.timeframe);
  if (!product) throw new Error("nicht bei Coinbase hinterlegt");
  if (![60, 300, 900, 3600].includes(step)) throw new Error("Zeitrahmen bei Coinbase nicht verfügbar");
  let end = Math.floor(Date.now() / 1000), rows = [], empty = 0;
  while (rows.length < n && empty < 2) {
    const start = end - 300 * step;
    const body = await getJson(fetchFn, `https://api.exchange.coinbase.com/products/${product}/candles?granularity=${step}` +
      `&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`);
    const page = (Array.isArray(body) ? body : []).map((k) => ({ t: k[0] * 1000, o: +k[3], h: +k[2], l: +k[1], c: +k[4], v: +k[5] }));
    empty = page.length ? 0 : empty + 1;
    rows = rows.concat(page);
    end = start;
    await sleep(120); // höflich gegenüber dem Ratenlimit
  }
  return rows;
}

// Historie für Backtests: nacheinander Bitstamp, Coinbase, Kraken (nur 720 Kerzen) – die erste Quelle mit genug Kerzen
// gewinnt, sonst die längste. Schneidet die noch offene letzte Kerze ab.
export async function fetchHistory(cfg, symbol, n = cfg.pipeline.historyCandles, fetchFn = fetch) {
  const asset = ASSETS[baseOf(symbol)], errors = [];
  const sources = [
    asset.bitstamp && ["Bitstamp", async () => rowsToFrame(await bitstampHistory(cfg, symbol, n, fetchFn))],
    asset.coinbase && ["Coinbase", async () => rowsToFrame(await coinbaseHistory(cfg, symbol, n, fetchFn))],
    ["Kraken", () => fetchRecent(cfg, symbol, fetchFn)],
  ].filter(Boolean);
  let df = null;
  for (const [name, load] of sources) {
    try {
      const got = await load();
      if (!df || got.close.length > df.close.length) df = got;
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
    if (df && df.close.length >= cfg.backtest.minCandles) break;
  }
  if (!df) throw new Error(`keine Kursdaten (${errors.join("; ")})`);
  const tfMs = timeframeSeconds(cfg.timeframe) * 1000;
  const keep = df.t.length - (df.t[df.t.length - 1] + tfMs > Date.now() ? 1 : 0);
  const from = Math.max(0, keep - n);
  const cut = (a) => a.slice(from, keep);
  return { t: cut(df.t), open: cut(df.open), high: cut(df.high), low: cut(df.low), close: cut(df.close), volume: cut(df.volume) };
}
