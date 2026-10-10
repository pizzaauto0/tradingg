// Marktdaten (öffentliche REST-APIs, keine Schlüssel): Kraken für Live-Kerzen, Bitstamp (Fallback Kraken) für die Historie.
// Kerzen-Format: { t: [ms], open: [], high: [], low: [], close: [], volume: [] }
import { timeframeSeconds } from "./util.js";

const KRAKEN_PAIR = "SOLUSD", BITSTAMP_PAIR = "solusd";
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
export async function fetchRecent(cfg, fetchFn = fetch) {
  const body = await getJson(fetchFn, `https://api.kraken.com/0/public/OHLC?pair=${KRAKEN_PAIR}&interval=${KRAKEN_INTERVAL[cfg.timeframe]}`);
  if (body.error?.length) throw new Error(`Kraken: ${body.error.join(", ")}`);
  const key = Object.keys(body.result).find((k) => k !== "last");
  const df = rowsToFrame(body.result[key].map((r) => ({ t: r[0] * 1000, o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[6] })));
  if (df.close.length < 150) throw new Error("Zu wenige Kerzen von Kraken erhalten");
  return df;
}

async function bitstampHistory(cfg, n, fetchFn) {
  const step = timeframeSeconds(cfg.timeframe);
  let end = Math.floor(Date.now() / 1000), rows = [], empty = 0;
  while (rows.length < n && empty < 2) {
    const start = end - 1000 * step;
    const body = await getJson(fetchFn, `https://www.bitstamp.net/api/v2/ohlc/${BITSTAMP_PAIR}/?step=${step}&limit=1000&start=${start}&end=${end}`);
    const page = (body?.data?.ohlc ?? []).map((k) => ({ t: +k.timestamp * 1000, o: +k.open, h: +k.high, l: +k.low, c: +k.close, v: +k.volume }));
    empty = page.length ? 0 : empty + 1;
    rows = rows.concat(page);
    end = start - 1;
  }
  return rows;
}

// Historie für Backtests; schneidet die noch offene letzte Kerze ab.
export async function fetchHistory(cfg, n = cfg.pipeline.historyCandles, fetchFn = fetch) {
  let df = null;
  try {
    df = rowsToFrame(await bitstampHistory(cfg, n, fetchFn));
  } catch (e) {
    console.warn("Bitstamp-Historie fehlgeschlagen:", e.message);
  }
  if (!df || df.close.length < cfg.backtest.minCandles) {
    try {
      const kr = await fetchRecent(cfg, fetchFn);
      if (!df || kr.close.length > df.close.length) df = kr;
    } catch (e) {
      if (!df) throw e;
    }
  }
  const tfMs = timeframeSeconds(cfg.timeframe) * 1000;
  const keep = df.t.length - (df.t[df.t.length - 1] + tfMs > Date.now() ? 1 : 0);
  const from = Math.max(0, keep - n);
  const cut = (a) => a.slice(from, keep);
  return { t: cut(df.t), open: cut(df.open), high: cut(df.high), low: cut(df.low), close: cut(df.close), volume: cut(df.volume) };
}
