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
