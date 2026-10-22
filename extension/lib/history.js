// Bisherige Trades: Kauf und Verkauf zu einem Datensatz zusammenfassen, samt Stop-/Ziel-Verlauf (für die Chart-Ansicht im Dashboard).
// Reine Funktion ohne Netzwerk. trades: Trade-Protokoll eines Bots (alt → neu).
export const exitKind = (reason = "") => /Stop-Loss/.test(reason) ? "Stop-Loss" : /Take-Profit/.test(reason) ? "Ziel erreicht" : /Ausstiegssignal/.test(reason) ? "Signal" : /Manuell/i.test(reason) ? "Manuell" : "Sonstiges";

export function pairTrades(trades) {
  const open = new Map(), out = [];
  for (const t of trades) {
    if (t.action === "ENTRY") open.set(t.symbol, t);
    else if (t.action === "EXIT") {
      const en = open.get(t.symbol); open.delete(t.symbol);
      const entryTs = t.entryTs || en?.ts, entryPrice = t.entryPrice ?? en?.price;
      if (!entryTs || entryPrice == null) continue;
      const adj = t.adj || [], firstStop = adj.find((a) => a.kind === "stop"), firstTp = adj.find((a) => a.kind === "tp");
      out.push({ id: `${t.symbol}@${t.ts}`, symbol: t.symbol, entryTs, exitTs: t.ts, entryPrice, exitPrice: t.price, amount: t.amount, pnl: t.pnl, fees: (en?.fee || 0) + (t.fee || 0),
        strategy: t.strategy, regime: t.regime, kind: exitKind(t.reason), reason: t.reason, adj,
        initStop: t.initStop ?? firstStop?.from ?? null, initTp: t.initTp ?? firstTp?.from ?? t.takeProfit ?? null, stop: t.stop ?? null, takeProfit: t.takeProfit ?? null });
    }
  }
  return out.reverse();   // neueste zuerst
}

// Stufenlinie: [{ts, price}] vom Einstieg an, je Anpassung ein neuer Punkt, bis zum Ausstieg
export function levelSteps(trade, kind) {
  const start = kind === "stop" ? trade.initStop : trade.initTp;
  if (start == null) return [];
  const pts = [{ ts: Date.parse(trade.entryTs), price: start }];
  for (const a of trade.adj || []) if (a.kind === kind) pts.push({ ts: Date.parse(a.ts), price: a.to });
  return pts;
}
