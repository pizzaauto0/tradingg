// Live-Statistik für Discord (Embeds): Konto, Bilanz der abgeschlossenen Trades (netto nach Gebühren), offene Positionen je Bot,
// letzte Käufe und Verkäufe. Reine Funktionen ohne Netzwerk – gespeist von controller.getLiveStats().
import { fmtPx } from "./util.js";

const usd = (x, sign = false) => `${sign && x >= 0 ? "+" : ""}${x.toFixed(2)} USD`;
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
    ? `🟢 **KAUF** ${t.symbol} @ ${fmtPx(t.price)} · ${tstamp(t.ts)}${bot}`
    : `${t.pnl >= 0 ? "✅" : "🔴"} **VERKAUF** ${t.symbol} @ ${fmtPx(t.price)} · ${usd(t.pnl, true)} · ${tstamp(t.ts)}${bot}`;
};

// snap: { account: getAccount(), bots: [{ id, label, enabled, positions: [{ symbol, amount, entryPrice, stop, takeProfit, price, strategyName, openedAt }] }], trades: [...], now: ISO }
// view: "stats" (alles) | "positions" (offene Trades) | "trades" (letzte Käufe/Verkäufe)
export function buildStatsEmbed(snap, view = "stats") {
  const { account: a, bots } = snap, trades = snap.trades.filter((t) => t.action === "ENTRY" || t.action === "EXIT"), labels = Object.fromEntries(bots.map((b) => [b.id, b.label]));
  const all = tradeStats(trades), fields = [];
  const open = bots.flatMap((b) => b.positions.map((p) => ({ ...p, bot: b.label })));
  const unreal = open.reduce((x, p) => x + (p.price - p.entryPrice) * p.amount, 0);

  if (view === "profit") {
    const P = snap.profit, names = { today: "📅 Heute", week: "🗓 Letzte Woche (7 Tage)", month: "📆 Letzte 30 Tage", total: "🏁 Insgesamt (seit Start)" };
    for (const [k, label] of Object.entries(names)) {
      const p = P.periods[k];
      fields.push({ name: label, value: `**${usd(p.usd, true)}** (${p.pct >= 0 ? "+" : ""}${p.pct.toFixed(2)} %) Eigenkapital-Änderung${p.partial ? " · Verlauf beginnt später" : ""}\n` +
        `realisiert ${usd(p.realized, true)} · ${p.buys} Käufe, ${p.sells} Verkäufe${p.sells ? ` (${p.wins} Gewinn, ${p.winRate.toFixed(0)} %)` : ""} · Gebühren ${usd(p.fees)}` });
    }
    const per = Object.keys(P.bots).map((id) => `**${P.labels[id]}**: heute ${usd(P.bots[id].today.realized, true)} · 7 Tage ${usd(P.bots[id].week.realized, true)} · gesamt ${usd(P.bots[id].total.realized, true)}`).join("\n");
    fields.push({ name: "🤖 Je Bot (realisiert, netto)", value: per });
  }
  if (view === "stats") {
    fields.push({ name: "💼 Konto (gemeinsam)", value: `Eigenkapital **${usd(a.equity)}** (${usd(a.pnl, true)}, ${a.pnlPct >= 0 ? "+" : ""}${a.pnlPct.toFixed(2)} %)\nBargeld ${usd(a.cash)} · gebunden ${usd(a.held)} · offenes Ergebnis ${usd(unreal, true)}` });
    fields.push({ name: "📈 Bilanz (abgeschlossen, netto nach Gebühren)", value: all.closed
      ? `${all.closed} Verkäufe: ${all.wins} Gewinn / ${all.losses} Verlust (${all.winRate.toFixed(0)} %)\nSumme **${usd(all.pnl, true)}** · Gebühren gesamt ${usd(all.fees)}\nBester ${usd(all.best, true)} · schlechtester ${usd(all.worst, true)}`
      : `Noch kein abgeschlossener Trade (${all.entries} Kauf/Käufe).` });
  }
  if (view === "stats" || view === "positions") {
    for (const b of bots) {
      const lines = b.positions.map((p) => {
        const pnl = (p.price - p.entryPrice) * p.amount;
        return `${pnl >= 0 ? "🟢" : "🔴"} **${p.symbol}** ${p.amount.toFixed(5)} @ ${fmtPx(p.entryPrice)} → jetzt ${fmtPx(p.price)} (${usd(pnl, true)}, ${(((p.price / p.entryPrice) - 1) * 100).toFixed(2)} %)\n   Stop-Loss ${fmtPx(p.stop)} · Take-Profit ${fmtPx(p.takeProfit)} · seit ${tstamp(p.openedAt)}\n   ${short(p.strategyName || "", 60)}`;
      });
      const mine = tradeStats(trades.filter((t) => (t.bot || "crypto") === b.id));
      fields.push({ name: `${b.enabled ? "▶️" : "⏸"} ${b.label} · ${b.positions.length} offen · ${mine.closed} verkauft (${usd(mine.pnl, true)})`, value: short(lines.join("\n") || "keine offene Position", 1000) });
    }
  }
  if (view === "stats" || view === "trades") {
    const last = trades.slice(-(view === "trades" ? 15 : 6)).reverse();
    fields.push({ name: view === "trades" ? "🧾 Letzte Käufe & Verkäufe" : "🧾 Zuletzt", value: short(last.map((t) => tradeLine(t, labels)).join("\n") || "noch keine Trades", 1000) });
  }
  const ref = view === "profit" ? snap.profit.periods.today.usd : a.pnl;
  const up = ref > 0.005, down = ref < -0.005;
  return {
    title: view === "profit" ? "💰 Profit" : view === "positions" ? "📌 Offene Trades" : view === "trades" ? "🧾 Käufe & Verkäufe" : "📊 Live-Statistik",
    description: `Paper-Handel (Spielgeld) · Stand ${tstamp(snap.now, "T")}`,
    color: up ? COLORS.up : down ? COLORS.down : COLORS.flat, fields: fields.slice(0, 25), footer: { text: "Trading-Bot · Gebühren eingerechnet" }, timestamp: snap.now,
  };
}

// Knopfleiste unter dem Panel bzw. unter der Antwort (custom_id wird vom Bot ausgewertet)
export const PANEL_BUTTONS = [{ type: 1, components: [
  { type: 2, style: 1, label: "📊 Live-Statistik", custom_id: "stats" },
  { type: 2, style: 3, label: "💰 Profit", custom_id: "profit" },
  { type: 2, style: 2, label: "📌 Offene Trades", custom_id: "positions" },
  { type: 2, style: 2, label: "🧾 Käufe & Verkäufe", custom_id: "trades" },
] }];
export const REFRESH_BUTTONS = (view) => [{ type: 1, components: [{ type: 2, style: 1, label: "🔄 Aktualisieren", custom_id: view }, ...PANEL_BUTTONS[0].components.filter((c) => c.custom_id !== view)] }];
