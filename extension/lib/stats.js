// Live-Statistik für Discord (Embeds): übersichtlich und mit verständlichen Strategie-Namen. Reine Funktionen ohne Netzwerk – gespeist von controller.getLiveStats().
import { fmtPx } from "./util.js";
import { strategyLabel } from "./names.js";

const usd = (x, sign = false) => `${sign && x >= 0 ? "+" : ""}${x.toFixed(2)} USD`;
const pct = (to, from) => `${to >= from ? "+" : ""}${(((to / from) - 1) * 100).toFixed(1)} %`;
const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const tstamp = (iso, style = "R") => `<t:${Math.floor(Date.parse(iso) / 1000)}:${style}>`;   // Discord zeigt die Zeit in der Zeitzone des Betrachters
const COLORS = { up: 0x2ecc71, down: 0xe74c3c, flat: 0x3498db };

export function tradeStats(trades) {
  const exits = trades.filter((t) => t.action === "EXIT" && t.pnl != null);
  const wins = exits.filter((t) => t.pnl > 0);
  const pnl = exits.reduce((x, t) => x + t.pnl, 0);
  const fees = trades.reduce((x, t) => x + (t.fee || 0), 0);
  return { closed: exits.length, wins: wins.length, losses: exits.length - wins.length, winRate: exits.length ? (wins.length / exits.length) * 100 : null, pnl, fees,
    best: exits.length ? Math.max(...exits.map((t) => t.pnl)) : null, worst: exits.length ? Math.min(...exits.map((t) => t.pnl)) : null,
    entries: trades.filter((t) => t.action === "ENTRY").length };
}

const tradeLine = (t, labels) => {
  const bot = labels[t.bot || "crypto"] ? ` · ${labels[t.bot || "crypto"]}` : "";
  return t.action === "ENTRY"
    ? `🟢 **Kauf** ${t.symbol} @ ${fmtPx(t.price)} · ${strategyLabel(t.strategy)} · ${tstamp(t.ts)}${bot}`
    : `${t.pnl >= 0 ? "✅" : "🔴"} **Verkauf** ${t.symbol} @ ${fmtPx(t.price)} · **${usd(t.pnl, true)}** · ${strategyLabel(t.strategy)} · ${tstamp(t.ts)}${bot}`;
};

// Eine offene Position in zwei Zeilen: Farbe = im Plus/Minus, dazu Strategie und seit wann
const positionLines = (p, botLabel) => {
  const pnl = (p.price - p.entryPrice) * p.amount;
  return `${pnl >= 0 ? "🟢" : "🔴"} **${p.symbol}** ${usd(pnl, true)} (${pct(p.price, p.entryPrice)}) · ${strategyLabel(p.strategyName)} · geöffnet ${tstamp(p.openedAt)}${botLabel ? ` · ${botLabel}` : ""}\n` +
    `　Einstieg ${fmtPx(p.entryPrice)} → jetzt ${fmtPx(p.price)} · Stop-Loss ${fmtPx(p.stop)} · Take-Profit ${fmtPx(p.takeProfit)}`;
};

// snap: { account, bots: [{ id, label, modeLabel, enabled, positions }], trades, profit, now }
// view: "stats" (Übersicht) | "profit" | "positions" | "trades"
export function buildStatsEmbed(snap, view = "stats") {
  const { account: a, bots } = snap, trades = snap.trades.filter((t) => t.action === "ENTRY" || t.action === "EXIT"), labels = Object.fromEntries(bots.map((b) => [b.id, b.label]));
  const all = tradeStats(trades), fields = [];
  const open = bots.flatMap((b) => b.positions.map((p) => ({ ...p, bot: b.label })));
  const unreal = open.reduce((x, p) => x + (p.price - p.entryPrice) * p.amount, 0);
  const P = snap.profit;

  if (view === "profit") {
    const names = { today: "📅 Heute", week: "🗓 Letzte Woche", month: "📆 Letzte 30 Tage", total: "🏁 Insgesamt" };
    for (const [k, label] of Object.entries(names)) {
      const p = P.periods[k];
      fields.push({ name: label, value: `**${usd(p.usd, true)}** (${p.pct >= 0 ? "+" : ""}${p.pct.toFixed(2)} %)${p.partial ? " · Verlauf beginnt später" : ""}\n` +
        `realisiert ${usd(p.realized, true)} · ${p.buys} Käufe, ${p.sells} Verkäufe${p.sells ? ` (${p.wins} im Plus, ${p.winRate.toFixed(0)} %)` : ""} · Gebühren ${usd(p.fees)}`, inline: false });
    }
    const per = Object.keys(P.bots).map((id) => `**${P.labels[id]}**: heute ${usd(P.bots[id].today.realized, true)} · 7 Tage ${usd(P.bots[id].week.realized, true)} · gesamt ${usd(P.bots[id].total.realized, true)}`).join("\n");
    fields.push({ name: "🤖 Je Bot (realisiert, netto)", value: per });
  }
  if (view === "stats") {
    const today = P?.periods?.today;
    fields.push({ name: "💼 Konto", value: `Eigenkapital **${usd(a.equity)}** (${usd(a.pnl, true)}, ${a.pnlPct >= 0 ? "+" : ""}${a.pnlPct.toFixed(2)} %)\n${today ? `Heute **${usd(today.usd, true)}** · ` : ""}Bargeld ${usd(a.cash)} · offenes Ergebnis ${usd(unreal, true)}` });
    fields.push({ name: "🤖 Bots (Haupt-Modus)", value: bots.map((b) => `${b.enabled ? "▶️" : "⏸"} **${b.label}** · ${b.modeLabel || "–"} · ${b.positions.length} offen`).join("\n") });
    fields.push({ name: `📌 Offene Positionen (${open.length})`, value: short(open.map((p) => positionLines(p, p.bot)).join("\n") || "keine offene Position", 1000) });
    fields.push({ name: "📈 Bilanz (abgeschlossen, netto)", value: all.closed
      ? `${all.closed} Verkäufe: ${all.wins} im Plus / ${all.losses} im Minus (${all.winRate.toFixed(0)} %) · Summe **${usd(all.pnl, true)}**\nGebühren gesamt ${usd(all.fees)} · bester ${usd(all.best, true)} · schlechtester ${usd(all.worst, true)}`
      : `Noch kein abgeschlossener Trade (${all.entries} Kauf/Käufe).` });
    fields.push({ name: "🧾 Zuletzt", value: short(trades.slice(-4).reverse().map((t) => tradeLine(t, labels)).join("\n") || "noch keine Trades", 1000) });
  }
  if (view === "positions") {
    for (const b of bots) fields.push({ name: `${b.enabled ? "▶️" : "⏸"} ${b.label} · ${b.positions.length} offen`, value: short(b.positions.map((p) => positionLines(p)).join("\n") || "keine offene Position", 1000) });
  }
  if (view === "trades") {
    fields.push({ name: "🧾 Letzte Käufe & Verkäufe", value: short(trades.slice(-15).reverse().map((t) => tradeLine(t, labels)).join("\n") || "noch keine Trades", 1000) });
  }
  const ref = view === "profit" ? P.periods.today.usd : a.pnl;
  const up = ref > 0.005, down = ref < -0.005;
  return {
    title: { stats: "📊 Übersicht", profit: "💰 Profit", positions: "📌 Offene Positionen", trades: "🧾 Käufe & Verkäufe" }[view],
    description: `Paper-Handel (Spielgeld) · Stand ${tstamp(snap.now, "T")}`,
    color: up ? COLORS.up : down ? COLORS.down : COLORS.flat, fields: fields.slice(0, 25), footer: { text: "Trading-Bot · Gebühren eingerechnet" }, timestamp: snap.now,
  };
}

// Knopfleiste unter dem Panel bzw. unter der Antwort (custom_id wird vom Bot ausgewertet)
export const PANEL_BUTTONS = [{ type: 1, components: [
  { type: 2, style: 1, label: "📊 Übersicht", custom_id: "stats" },
  { type: 2, style: 3, label: "💰 Profit", custom_id: "profit" },
  { type: 2, style: 2, label: "📌 Positionen", custom_id: "positions" },
  { type: 2, style: 2, label: "🧾 Trades", custom_id: "trades" },
] }];
export const REFRESH_BUTTONS = (view) => [{ type: 1, components: [{ type: 2, style: 1, label: "🔄 Aktualisieren", custom_id: view }, ...PANEL_BUTTONS[0].components.filter((c) => c.custom_id !== view)] }];
