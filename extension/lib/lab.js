// Labor: Sehr viele Schatten-Läufe mit eigenem Paper-Geld, die sich von einer festen BASIS in genau EINER Einstellung unterscheiden.
// So sieht man, woran ein Unterschied liegt (nicht „15m statt 1h UND 20 % Risiko“). Reine Funktionen ohne Speicherzugriff (siehe controller.tickLab).
import { ALLOWED_TIMEFRAMES, botAssets } from "./config.js";
import { summarizeMode } from "./compare.js";
import { strategyLabel } from "./names.js";
import { exitKind } from "./history.js";

const N = (v) => String(v).replace(".", ",");
// Jede Gruppe ändert genau eine Einstellung (path) auf jeweils andere Werte; Werte, die der Basis entsprechen, werden ausgelassen.
export const LAB_GROUPS = [
  { id: "tf", label: "Zeitrahmen", path: "timeframe", values: ALLOWED_TIMEFRAMES, name: (v) => `Zeitrahmen ${v}` },
  { id: "risk", label: "Risiko pro Trade", path: "risk.riskPerTradePct", values: [0.1, 0.25, 0.5], name: (v) => `Risiko ${N(v)} %`, note: "Ab ca. 0,75 % greift der Deckel „max. Positionsgröße“ – darüber ändert sich nichts mehr" },
  { id: "maxpos", label: "Max. Positionsgröße (% Kapital)", path: "risk.maxPositionPct", values: [10, 25, 100], name: (v) => `Position bis ${v} %` },
  { id: "stop", label: "Stop-Abstand (× ATR)", path: "risk.atrStopMult", values: [1, 1.5, 3, 4], name: (v) => `Stop ${N(v)}×ATR` },
  { id: "rr", label: "Ziel (× Stop-Abstand)", path: "risk.takeProfitRr", values: [1, 1.5, 3, 4], name: (v) => `Ziel ${N(v)}×` },
  { id: "minstop", label: "Mindest-Stopabstand", path: "risk.minStopPct", values: [0, 0.75, 3], name: (v) => (v ? `Mindest-Stop ${N(v)} %` : "ohne Mindest-Stop") },
  { id: "cost", label: "Kosten-Filter (Ziel ≥ X × Kosten)", path: "risk.minRewardToCost", values: [0, 3, 4], name: (v) => (v ? `Kosten-Filter ${v}×` : "ohne Kosten-Filter") },
  { id: "weak", label: "Marktfilter (Anteil unter EMA50)", path: "risk.weakMarketShare", values: [0, 0.5, 0.85], name: (v) => (v ? `Marktfilter ${Math.round(v * 100)} %` : "ohne Marktfilter") },
  { id: "hold", label: "Mindest-Haltedauer (Kerzen)", path: "risk.minHoldBars", values: [0, 8], name: (v) => (v ? `Haltedauer ${v} Kerzen` : "ohne Haltedauer") },
  { id: "pos", label: "Gleichzeitige Positionen", path: "risk.maxOpenPositions", values: [1, 4, 8], name: (v) => `${v} Positionen` },
  { id: "cool", label: "Abkühlung nach Stop (Std.)", path: "safety.symbolCooldownHours", values: [0, 12], name: (v) => (v ? `Abkühlung ${v} Std.` : "ohne Abkühlung") },
  { id: "strat", label: "Strategie-Sperre (Verluste)", path: "safety.stratMaxLosses", values: [0, 1, 3], name: (v) => (v ? `Sperre nach ${v} Verlust${v > 1 ? "en" : ""}` : "ohne Sperre") },
  { id: "tstart", label: "Trailing-Start (% Gewinn)", path: "trail.startPct", values: [0, 2, 3, 8], name: (v) => (v ? `Trailing ab ${v} %` : "Trailing alte Regel (USD/R)") },
  { id: "toff", label: "Trailing", path: "trail.enabled", values: [false], name: () => "ohne Trailing" },
  { id: "lock", label: "Trailing: gesicherter Anteil", path: "trail.lockFraction", values: [0.5, 0.9], name: (v) => `Trailing sichert ${Math.round(v * 100)} %` },
  { id: "assets", label: "Märkte", path: "assets", values: [["BTC", "ETH", "SOL"]], only: "crypto", name: () => "nur BTC, ETH, SOL" },
];

const getPath = (o, p) => p.split(".").reduce((x, k) => x?.[k], o);
function setPath(o, p, v) { const ks = p.split("."); let x = o; for (const k of ks.slice(0, -1)) x = x[k] ||= {}; x[ks.at(-1)] = v; }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Basis: Einstellungen des Bots, aber Playbook (feste Strategien → es wird überhaupt gehandelt), eigenes Paper-Geld, stumm
export function labBase(main, botId) {
  const c = JSON.parse(JSON.stringify(main));
  Object.assign(c, { liveTrading: false });
  c.backtest.profile = "playbook";
  c.discord = { ...c.discord, enabled: false, logEnabled: false }; c.telegram = { ...c.telegram, enabled: false };
  c.assets = botAssets(botId);
  return c;
}

export function labVariants(main, botId) {
  const base = labBase(main, botId), out = [{ id: "base", group: "base", groupLabel: "Basis", label: "BASIS", change: "keine Änderung", cfg: base }];
  for (const g of LAB_GROUPS) {
    if (g.only && g.only !== botId) continue;
    const baseVal = g.path === "assets" ? null : getPath(base, g.path);
    for (const v of g.values) {
      const val = g.path === "assets" ? v.filter((a) => botAssets(botId).includes(a)) : v;
      if (g.path === "assets" ? !val.length : same(val, baseVal)) continue;
      const cfg = JSON.parse(JSON.stringify(base)); setPath(cfg, g.path, val);
      out.push({ id: `${g.id}_${Array.isArray(v) ? "sel" : v}`, group: g.id, groupLabel: g.label, label: g.name(v), change: `${g.label}: ${g.path === "assets" ? "alle" : String(baseVal)} → ${g.path === "assets" ? val.join("/") : String(val)}`, cfg });
    }
  }
  return out;
}

// Kennzahlen einer Variante (entry = gespeicherter Lauf: state, account, trades, eq)
export function labRow(v, entry) {
  const st = entry?.state || { positions: {}, activity: {} }, trades = entry?.trades || [];
  const prices = Object.fromEntries(Object.entries(st.activity || {}).filter(([, a]) => a?.price != null).map(([s, a]) => [s, a.price]));
  const cap = v.cfg.capital.start, sum = summarizeMode({ capital: cap, trades, positions: st.positions || {}, prices, eqLog: entry?.eq || [] });
  const equity = (entry?.account?.cash ?? cap) + Object.values(st.positions || {}).reduce((x, p) => x + p.amount * (prices[p.symbol] ?? p.entryPrice), 0);
  const ent = trades.filter((t) => t.action === "ENTRY" && t.equity > 0);
  const avgSizePct = ent.length ? (ent.reduce((x, t) => x + (t.amount * t.price) / t.equity, 0) / ent.length) * 100 : null;
  return { id: v.id, group: v.group, groupLabel: v.groupLabel, label: v.label, change: v.change, timeframe: v.cfg.timeframe, equity, profit: sum.profit, pct: sum.pct, realized: sum.realized, unrealized: sum.unrealized,
    closed: sum.perf.trades, entries: sum.entries, winRate: sum.perf.winRate, profitFactor: sum.perf.profitFactor, maxDrawdownPct: sum.perf.maxDrawdownPct, fees: sum.fees, open: sum.open, avgSizePct,
    lastError: st.lastError || null, lastTick: st.lastTick || null, ready: !!entry };
}

export function labRows(variants, entries) {
  const rows = variants.map((v) => labRow(v, entries[v.id])), base = rows[0];
  for (const r of rows) { r.delta = r.profit - base.profit; r.enough = r.closed >= 8 && base.closed >= 8; }
  return rows;
}

// Kurze Erkenntnisse: je Gruppe die beste und schlechteste Abweichung von der Basis (mit Hinweis auf zu wenige Trades)
export function labInsights(rows) {
  const base = rows[0], out = [], groups = [...new Set(rows.slice(1).map((r) => r.group))];
  for (const g of groups) {
    const rs = rows.filter((r) => r.group === g && r.ready), best = [...rs].sort((a, b) => b.profit - a.profit)[0], worst = [...rs].sort((a, b) => a.profit - b.profit)[0];
    if (!best) continue;
    const f = (r) => `${r.label} ${r.delta >= 0 ? "+" : ""}${r.delta.toFixed(2)} USD vs. Basis (${r.closed} Trades${r.enough ? "" : ", noch zu wenig"})`;
    out.push(`${rs[0].groupLabel}: ${best.delta > 0 ? "besser: " + f(best) : "keine Variante besser als die Basis"}${worst !== best && worst.delta < 0 ? " · schlechter: " + f(worst) : ""}`);
  }
  return base ? out : [];
}

const f2 = (x, d = 2) => (x == null || !Number.isFinite(x) ? "–" : x.toFixed(d));
const sg = (x) => (x == null || !Number.isFinite(x) ? "–" : `${x >= 0 ? "+" : ""}${x.toFixed(2)}`);

// Text für die Log-Datei (Stunde/6h) und zum Kopieren
export function labLogText({ botLabel, now, rows, kind, since, entries, variants }) {
  const L = [], base = rows[0], when = new Date(now).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
  L.push(`${kind === "6h" ? "LABOR 6-STUNDEN-BERICHT" : "LABOR STUNDENBERICHT"} · ${botLabel} · ${when}`);
  L.push("Jede Variante weicht von der BASIS in genau einer Einstellung ab (eigenes Paper-Geld, je 300 USD). Δ = Gewinn minus Gewinn der Basis. Unter 8 abgeschlossenen Trades ist der Vergleich unsicher.");
  L.push(`BASIS: Playbook · Zeitrahmen ${base.timeframe} · Risiko/Stop/Ziel/Filter wie in den Einstellungen`);
  L.push("");
  const head = (s) => L.push(`${s.name.padEnd(28)} ${"Eigenkap.".padStart(9)} ${"Gewinn".padStart(8)} ${"Δ Basis".padStart(8)} ${"Trades".padStart(6)} ${"Treffer".padStart(7)} ${"PF".padStart(5)} ${"Geb.".padStart(6)} ${"Ø Einsatz".padStart(9)} offen`);
  const line = (r) => L.push(`${r.label.padEnd(28)} ${f2(r.equity).padStart(9)} ${sg(r.profit).padStart(8)} ${(r.id === "base" ? "–" : sg(r.delta)).padStart(8)} ${String(r.closed).padStart(6)} ${(r.winRate == null ? "–" : f2(r.winRate, 0) + "%").padStart(7)} ${(r.profitFactor === Infinity ? "∞" : f2(r.profitFactor)).padStart(5)} ${f2(r.fees).padStart(6)} ${(r.avgSizePct == null ? "–" : f2(r.avgSizePct, 0) + "%").padStart(9)} ${r.open}${r.lastError ? "  ! " + r.lastError.slice(0, 60) : ""}`);
  head({ name: "Variante" }); line(base);
  for (const g of [...new Set(rows.slice(1).map((r) => r.group))]) {
    const rs = rows.filter((r) => r.group === g);
    L.push(""); L.push(`— ${rs[0].groupLabel}${LAB_GROUPS.find((x) => x.id === g)?.note ? ` (${LAB_GROUPS.find((x) => x.id === g).note})` : ""}`);
    for (const r of rs) line(r);
  }
  const ins = labInsights(rows);
  if (ins.length) { L.push(""); L.push("Auffälligkeiten:"); for (const x of ins) L.push(`  • ${x}`); }
  if (kind === "6h") {
    L.push(""); L.push(`Abgeschlossene Trades der letzten 6 Stunden (alle Varianten):`);
    let n = 0;
    for (const v of variants) for (const t of (entries[v.id]?.trades || []).filter((t) => t.action === "EXIT" && Date.parse(t.ts) >= since)) {
      if (n++ > 150) break;
      L.push(`  ${v.label.padEnd(26)} ${t.symbol.padEnd(9)} ${sg(t.pnl).padStart(7)} USD · ${exitKind(t.reason)} · ${strategyLabel(t.strategy || "")}${t.analysis ? " · " + String(t.analysis).split("\n").pop().replace(/^Analyse: /, "").slice(0, 200) : ""}`);
    }
    if (!n) L.push("  keine");
  }
  return L.join("\r\n") + "\r\n";
}
