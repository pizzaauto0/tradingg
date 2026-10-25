// Mehrere Modi gleichzeitig vergleichen: Pro Bot (Währungen, Silber & Gold, Krypto) läuft der HAUPT-Modus mit dem gemeinsamen Paper-Konto,
// die übrigen Modi (strict, explore, playbook, winrate, final) laufen als Schatten-Läufe mit EIGENEM Paper-Geld und eigenen Positionen mit –
// gleiche Märkte, gleiche Regeln, nur andere Strategie-Auswahl. So entstehen vergleichbare Statistiken. Reine Hilfsfunktionen (kein Speicherzugriff).
import { fmtPx } from "./util.js";
import { strategyLabel, stamp } from "./names.js";
import { exitKind } from "./history.js";
import { botAssets } from "./config.js";
import { performance } from "./profit.js";

export const MODE_IDS = ["strict", "explore", "playbook", "winrate", "final"];
export const MODE_LABEL = { strict: "Streng", explore: "Erkunden", playbook: "Playbook", winrate: "Trefferquote", final: "Final-3" };
export const MODE_HELP = {
  strict: "strenge Mindestwerte (Standard)", explore: "gelockerte Mindestwerte", playbook: "5 feste Strategien (trading.de), Marktphase wählt",
  winrate: "5 feste Strategien mit hoher Trefferquote", final: "3 feste Strategien aus dem Tageskerzen-Test (1d)",
};

export const shadowKeys = (botId, mode) => ({ state: `shadow_${botId}_${mode}`, account: `shadowAcc_${botId}_${mode}`, trades: `shadowTrades_${botId}_${mode}`, equity: `shadowEq_${botId}_${mode}` });

// Einstellungen eines Schatten-Laufs: wie der Bot, aber mit anderem Prüfmodus (Final-3 rechnet auf Tageskerzen)
export function shadowCfg(cfg, botId, mode) {
  const out = { ...cfg, liveTrading: false, backtest: { ...cfg.backtest, profile: mode }, discord: { ...cfg.discord, enabled: false, logEnabled: false }, telegram: { ...cfg.telegram, enabled: false } };
  if (mode === "final") {
    out.timeframe = "1d";
    out.assets = botId === "crypto" ? ["BTC", "ETH", "SOL", "PAXG"].filter((a) => botAssets("crypto").includes(a)) : botAssets(botId);
  }
  return out;
}

// Welche Modi laufen als Schatten? Alle eingeschalteten außer dem Haupt-Modus des Bots
export function shadowModes(cfg) {
  const c = cfg.compare || {};
  if (!c.enabled) return [];
  return MODE_IDS.filter((m) => c[m] !== false && m !== cfg.backtest.profile);
}

// Vergleichszahlen eines Modus: Gewinn = realisiert (netto) + offen; gleiche Rechnung für Haupt- und Schatten-Modus
export function summarizeMode({ capital, trades, positions, prices, eqLog = [] }) {
  const perf = performance(trades, eqLog);
  const realizedUsd = trades.filter((t) => t.action === "EXIT" && t.pnl != null).reduce((x, t) => x + t.pnl, 0);
  const unrealized = Object.values(positions).reduce((x, p) => x + ((prices?.[p.symbol] ?? p.entryPrice) - p.entryPrice) * p.amount, 0);
  const profit = realizedUsd + unrealized;
  return { profit, pct: capital > 0 ? (profit / capital) * 100 : 0, realized: realizedUsd, unrealized, open: Object.keys(positions).length, perf,
    fees: trades.reduce((x, t) => x + (t.fee || 0), 0), entries: trades.filter((t) => t.action === "ENTRY").length };
}

const f2 = (x, d = 2) => (x == null || !Number.isFinite(x) ? "–" : x.toFixed(d));
const sg = (x) => (x == null || !Number.isFinite(x) ? "–" : `${x >= 0 ? "+" : ""}${x.toFixed(2)}`);
const hm = (ms) => new Date(ms).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });

// Textkörper der Log-Dateien. d: { bot, botLabel, mode, main, now (ms), capital, equity, cash, sum (summarizeMode), positions, prices, trades (im Zeitraum), decisions, active, approved, hours, eqDelta, errors }
export function logText(d, kind) {
  const L = [];
  L.push(`${kind === "6h" ? "6-STUNDEN-BERICHT" : "STUNDENBERICHT"} · ${d.botLabel} · Modus ${MODE_LABEL[d.mode]} (${d.mode})${d.main ? " [HAUPT-MODUS, gemeinsames Paper-Konto]" : " [Schatten-Lauf, eigenes Paper-Geld]"}`);
  L.push(`Zeit: ${hm(d.now)} · Zeitraum: letzte ${d.hours} Stunde(n)`);
  L.push("");
  L.push(`Konto: Eigenkapital ${f2(d.equity)} USD · Bargeld ${f2(d.cash)} USD · Startkapital ${f2(d.capital)} USD${d.main ? " (gemeinsames Konto aller Bots)" : ""}`);
  L.push(`Gewinn dieses Modus gesamt: ${sg(d.sum.profit)} USD (${sg(d.sum.pct)} %) = realisiert ${sg(d.sum.realized)} + offen ${sg(d.sum.unrealized)} · Gebühren ${f2(d.sum.fees)} USD`);
  if (d.eqDelta != null) L.push(`Eigenkapital-Änderung im Zeitraum: ${sg(d.eqDelta)} USD`);
  const p = d.sum.perf;
  L.push(`Trades gesamt: ${p.trades} abgeschlossen (${d.sum.entries} Käufe) · Trefferquote ${p.winRate == null ? "–" : f2(p.winRate, 0) + " %"} · Profitfaktor ${p.profitFactor === Infinity ? "∞" : f2(p.profitFactor)} · Erwartungswert ${sg(p.expectancy)} USD · max. Drawdown ${f2(p.maxDrawdownPct, 1)} %`);
  L.push(`Strategien: ${d.approved} zugelassen, ${d.active.length} aktiv${d.active.length ? " → " + d.active.join("; ") : ""}`);
  L.push("");
  L.push(`Offene Positionen (${Object.keys(d.positions).length}):`);
  for (const q of Object.values(d.positions)) {
    const px = d.prices?.[q.symbol] ?? q.entryPrice;
    L.push(`  • ${q.symbol} ${f2(q.amount, 5)} @ ${fmtPx(q.entryPrice)} → ${fmtPx(px)} (${sg((px - q.entryPrice) * q.amount)} USD) | Stop ${fmtPx(q.stop)} | Ziel ${fmtPx(q.takeProfit)} | ${strategyLabel(q.strategyName)} | seit ${q.openedAt ? stamp(q.openedAt) : "–"}`);
  }
  if (!Object.keys(d.positions).length) L.push("  keine");
  L.push("");
  L.push(`Käufe und Verkäufe im Zeitraum (${d.trades.length}):`);
  for (const t of d.trades) {
    L.push(`  ${new Date(t.ts).toLocaleTimeString("de-DE")} ${t.action === "ENTRY" ? "KAUF   " : t.action === "EXIT" ? "VERKAUF" : t.action} ${t.symbol} @ ${fmtPx(t.price)}${t.pnl != null ? ` | Ergebnis netto ${sg(t.pnl)} USD` : ""} | ${strategyLabel(t.strategy || "")}`);
    if (t.reason) L.push(`      Warum: ${String(t.reason).replace(/\s*\n\s*/g, " ").slice(0, 700)}`);
    if (t.analysis) for (const a of String(t.analysis).split("\n")) L.push(`      ${a}`);
  }
  if (!d.trades.length) L.push("  keine");
  // Märkte jetzt: Kurs, Phase, ADX, gewählte Strategie – damit man im Nachhinein sieht, was der Bot gesehen hat
  const acts = Object.entries(d.state?.activity || {}).filter(([, a]) => a && !a.error && a.price != null), br = d.state?.breadth;
  if (acts.length) {
    L.push("");
    L.push(`Märkte (aktueller Stand)${br ? ` · Marktbreite: ${br.weak} von ${br.n} unter der EMA50${br.n >= 3 && br.weak / br.n >= (d.weakShare || 0.7) ? " → Marktfilter sperrt neue Käufe" : ""}` : ""}:`);
    for (const [s, a] of acts) L.push(`  ${s.padEnd(10)} ${String(fmtPx(a.price)).padStart(10)} · ${{ uptrend: "Aufwärts", downtrend: "Abwärts", sideways: "Seitwärts" }[a.regime] || "–"}${a.adx != null ? ` (ADX ${a.adx.toFixed(0)})` : ""} · ${a.strategy ? strategyLabel(a.strategy) : "keine passende Strategie"} · Signal ${a.signal == null ? "–" : a.signal ? "JA" : "nein"}`);
  }
  const cool = Object.entries(d.state?.symCool || {}).filter(([, c]) => Date.parse(c.until) > d.now), lock = Object.entries(d.state?.stratLoss || {}).filter(([, c]) => c.until && Date.parse(c.until) > d.now);
  if (cool.length || lock.length) {
    L.push(""); L.push("Gesperrt:");
    for (const [s, c] of cool) L.push(`  ${s}: Abkühlung nach Stop-Loss bis ${hm(Date.parse(c.until))}`);
    for (const [k, c] of lock) L.push(`  ${k.split("|")[0]} · ${strategyLabel(k.split("|")[1])}: Strategie-Sperre bis ${hm(Date.parse(c.until))}`);
  }
  // Auswertung über alle abgeschlossenen Trades dieses Modus: wo kommt der Gewinn/Verlust her?
  const ex = (d.allTrades || []).filter((t) => t.action === "EXIT" && t.pnl != null);
  if (ex.length) {
    const group = (key) => { const m = new Map(); for (const t of ex) { const k = key(t), g = m.get(k) || { n: 0, w: 0, sum: 0 }; g.n++; g.w += t.pnl > 0 ? 1 : 0; g.sum += t.pnl; m.set(k, g); } return [...m].sort((a, b) => a[1].sum - b[1].sum); };
    L.push(""); L.push(`Auswertung aller ${ex.length} abgeschlossenen Trades (netto, nach Gebühren):`);
    for (const [title, key] of [["je Strategie", (t) => strategyLabel(t.strategy || "")], ["je Markt", (t) => t.symbol], ["je Ausstiegsgrund", (t) => exitKind(t.reason)]]) {
      L.push(`  ${title}:`);
      for (const [k, g] of group(key)) L.push(`    ${String(k).padEnd(24)} ${String(g.n).padStart(3)} Trades · ${g.w} im Plus · ${sg(g.sum)} USD`);
    }
  }
  if (d.decisions.length) {
    L.push("");
    L.push(`Entscheidungen je Kerze (${kind === "hour" ? "Auszug" : "letzte"}, ${Math.min(d.decisions.length, kind === "hour" ? 80 : 40)} von ${d.decisions.length}):`);
    for (const x of d.decisions.slice(kind === "hour" ? -80 : -40)) L.push(`  ${new Date(x.ts).toLocaleTimeString("de-DE")} ${String(x.text).replace(" · Kerze geprüft", "")}`);
  }
  if (d.errors?.length) { L.push(""); L.push("Fehler/Hinweise:"); for (const e of d.errors.slice(-10)) L.push(`  ! ${e}`); }
  return L.join("\r\n") + "\r\n";
}
