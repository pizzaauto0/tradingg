// Gewinn über die Zeit: Eigenkapital-Verlauf (alle Bots, gemeinsames Konto) und Kennzahlen für Heute / 7 Tage / 30 Tage / Insgesamt.
// "Heute" = seit Mitternacht der Ortszeit dieses Rechners. Reine Funktionen ohne Speicherzugriff.
const MIN = 60_000, DAY = 86_400_000;

export const localMidnight = (now) => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); };

// Verlaufspunkte [ms, Eigenkapital]: höchstens alle 5 Minuten einer; ältere als 3 Tage nur stündlich (hält den Speicher klein)
export function appendEquity(log, nowMs, equity, gapMs = 5 * MIN) {
  const out = log.slice();
  const last = out.at(-1);
  if (!last || nowMs - last[0] >= gapMs) out.push([nowMs, Math.round(equity * 100) / 100]);
  if (out.length > 3000) {
    const cut = nowMs - 3 * DAY, keep = [];
    let lastHour = -1;
    for (const p of out) {
      if (p[0] >= cut) { keep.push(p); continue; }
      const h = Math.floor(p[0] / (60 * MIN));
      if (h !== lastHour) { keep.push(p); lastHour = h; }
    }
    return keep;
  }
  return out;
}

// Letzter bekannter Stand VOR (oder genau bei) ms; null, wenn der Verlauf später beginnt
export function equityAt(log, ms) {
  let v = null;
  for (const p of log) { if (p[0] <= ms) v = p[1]; else break; }
  return v;
}

export function realized(trades, fromMs) {
  const rows = trades.filter((t) => Date.parse(t.ts) >= fromMs && (t.action === "ENTRY" || t.action === "EXIT"));
  const exits = rows.filter((t) => t.action === "EXIT" && t.pnl != null), wins = exits.filter((t) => t.pnl > 0);
  return { realized: exits.reduce((x, t) => x + t.pnl, 0), buys: rows.filter((t) => t.action === "ENTRY").length, sells: exits.length, wins: wins.length,
    winRate: exits.length ? (wins.length / exits.length) * 100 : null, fees: rows.reduce((x, t) => x + (t.fee || 0), 0) };
}

// { log, trades, now (ms), capital, equity } → { today, week, month, total } mit usd/pct (Eigenkapitaländerung inkl. offener Positionen) und realisierten Zahlen
export function periodStats({ log, trades, now, capital, equity }) {
  const first = log[0]?.[1];
  const specs = { today: localMidnight(now), week: now - 7 * DAY, month: now - 30 * DAY, total: 0 };
  const out = {};
  for (const [key, from] of Object.entries(specs)) {
    const base = key === "total" ? capital : (equityAt(log, from) ?? first ?? equity);   // kein Verlauf davor: ab erstem bekannten Stand
    out[key] = { from, base, usd: equity - base, pct: base > 0 ? (equity / base - 1) * 100 : 0, ...realized(trades, from), partial: key !== "total" && equityAt(log, from) == null };
  }
  return out;
}

// Realisierter Gewinn je Bot und Zeitraum (aus den Trades; Eigenkapital gibt es nur für das ganze Konto)
export function byBot(trades, now, botIds) {
  const specs = { today: localMidnight(now), week: now - 7 * DAY, month: now - 30 * DAY, total: 0 };
  return Object.fromEntries(botIds.map((id) => [id, Object.fromEntries(Object.entries(specs).map(([k, from]) =>
    [k, realized(trades.filter((t) => (t.bot || "crypto") === id), from)]))]));
}

// Verlauf für die Anzeige: höchstens n Punkte
export function sampleCurve(log, n = 300) {
  if (log.length <= n) return log;
  const step = (log.length - 1) / (n - 1), out = [];
  for (let i = 0; i < n; i++) out.push(log[Math.round(i * step)]);
  return out;
}

// ---- Kennzahlen, Strategie-Rangliste, Export ----
const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

// Kennzahlen der abgeschlossenen Trades (netto) und des Eigenkapital-Verlaufs
export function performance(trades, log) {
  const exits = trades.filter((t) => t.action === "EXIT" && t.pnl != null).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const wins = exits.filter((t) => t.pnl > 0), losses = exits.filter((t) => t.pnl <= 0);
  const sumW = wins.reduce((x, t) => x + t.pnl, 0), sumL = -losses.reduce((x, t) => x + t.pnl, 0);
  let streak = 0, maxWin = 0, maxLoss = 0, w = 0, l = 0;
  for (const t of exits) { if (t.pnl > 0) { w++; l = 0; } else { l++; w = 0; } maxWin = Math.max(maxWin, w); maxLoss = Math.max(maxLoss, l); }
  streak = w > 0 ? w : -l;   // positiv = Gewinnserie, negativ = Verlustserie
  const days = {};
  for (const t of exits) days[dayKey(Date.parse(t.ts))] = (days[dayKey(Date.parse(t.ts))] || 0) + t.pnl;
  const dayRows = Object.entries(days);
  let peak = -Infinity, maxDd = 0, maxDdPct = 0;
  for (const [, v] of log) { peak = Math.max(peak, v); const dd = peak - v; if (dd > maxDd) { maxDd = dd; maxDdPct = (dd / peak) * 100; } }
  const cur = log.length ? log.at(-1)[1] : 0;
  return {
    trades: exits.length, wins: wins.length, losses: losses.length, winRate: exits.length ? (wins.length / exits.length) * 100 : null,
    avgWin: wins.length ? sumW / wins.length : null, avgLoss: losses.length ? -sumL / losses.length : null,
    payoff: wins.length && losses.length && sumL > 0 ? sumW / wins.length / (sumL / losses.length) : null,
    profitFactor: sumL > 0 ? sumW / sumL : (sumW > 0 ? Infinity : null), expectancy: exits.length ? (sumW - sumL) / exits.length : null,
    best: exits.length ? Math.max(...exits.map((t) => t.pnl)) : null, worst: exits.length ? Math.min(...exits.map((t) => t.pnl)) : null,
    streak, maxWinStreak: maxWin, maxLossStreak: maxLoss,
    bestDay: dayRows.length ? dayRows.reduce((a, b) => (b[1] > a[1] ? b : a)) : null, worstDay: dayRows.length ? dayRows.reduce((a, b) => (b[1] < a[1] ? b : a)) : null,
    maxDrawdown: maxDd, maxDrawdownPct: maxDdPct, peak: Number.isFinite(peak) ? peak : null, drawdown: Number.isFinite(peak) ? peak - cur : 0, drawdownPct: Number.isFinite(peak) && peak > 0 ? ((peak - cur) / peak) * 100 : 0,
  };
}

// Welche Strategie verdient? Gruppiert nach Name ohne Parameter (z. B. "breakout"); Manuelle Trades stehen als "Manuell"
export function byStrategy(trades) {
  const g = {};
  for (const t of trades.filter((x) => x.action === "EXIT" && x.pnl != null)) {
    const name = String(t.strategy || "?").replace(/^Test · /, "").split("(")[0].trim() || "?";
    const r = (g[name] ||= { name, trades: 0, wins: 0, pnl: 0 });
    r.trades++; r.pnl += t.pnl; if (t.pnl > 0) r.wins++;
  }
  return Object.values(g).map((r) => ({ ...r, winRate: (r.wins / r.trades) * 100, avg: r.pnl / r.trades })).sort((a, b) => b.pnl - a.pnl);
}

// CSV für Excel (Semikolon, Komma als Dezimalzeichen, UTF-8 mit BOM)
export function tradesToCsv(trades) {
  const q = (x) => `"${String(x ?? "").replaceAll('"', '""').replace(/\s*\n\s*/g, " ")}"`, n = (x) => (x == null ? "" : String(x).replace(".", ","));
  const head = ["Zeit", "Bot", "Markt", "Aktion", "Preis", "Menge", "Gebühr", "Ergebnis netto", "Strategie", "Marktphase", "Eigenkapital", "Begründung"];
  const rows = trades.map((t) => [t.ts, t.bot || "crypto", t.symbol, t.action, n(t.price), n(t.amount), n(t.fee), n(t.pnl), t.strategy, t.regime, n(t.equity), t.reason].map(q).join(";"));
  return "﻿" + [head.map(q).join(";"), ...rows].join("\r\n");
}
