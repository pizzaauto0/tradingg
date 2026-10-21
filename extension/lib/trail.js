// Nachziehen von Stop-Loss und Take-Profit („KI-Trailing“). Regelbasiert und nachvollziehbar – kein Sprachmodell, jede Entscheidung hat eine Begründung.
// Stop und Ziel werden hier NUR nach oben verschoben (nie gelockert) und nur, wenn die Position im Plus ist.
//
// Ablauf: Ab einem Gewinn von startUsd (z. B. 40) ODER startR (Vielfaches des ursprünglichen Risikos) wird der Stop so gesetzt, dass ein Teil des
// aktuellen Gewinns gesichert ist (Beispiel: +40 Gewinn, lockFraction 0,75 → Stop bei +30). Je nach Lage:
//   • starker Aufwärtstrend (Marktphase uptrend, ADX ≥ 25): weniger sichern (Spielraum, der Trend darf laufen) und das Ziel um 1R anheben, wenn der Kurs nahe daran ist;
//   • sonst (Seitwärts/Abwärts): mehr sichern.
// Nie näher als 0,5 ATR am Kurs (sonst wird die Position von normalem Rauschen ausgestoppt) und nie unter Einstand plus Kosten (der Stop soll wirklich im Plus liegen).
const last = (x) => x[x.length - 1];
export const TRAIL_MAX_TP_EXTENSIONS = 3;

// pos: Position; price: aktueller Kurs; atrValue: ATR; market: { regime, adx } oder null; t: cfg.trail; costFrac: Round-Trip-Kosten als Anteil (z. B. 0.009)
export function planTrail(pos, price, atrValue, market, t, costFrac = 0) {
  if (!t?.enabled || pos.trailOff || !(atrValue > 0)) return null;
  const unit = price - pos.entryPrice, profit = unit * pos.amount;
  if (!(profit > 0)) return null;
  const initStop = pos.initialStop ?? pos.stop;
  const risk = (pos.entryPrice - initStop) * pos.amount > 0 ? (pos.entryPrice - initStop) * pos.amount : 2 * atrValue * pos.amount;
  // Standard: ab startPct % Gewinn (auf den eingesetzten Betrag) wird nachgezogen; startPct = 0 → alte Regel (USD ODER Vielfaches des Risikos)
  const armed = t.startPct > 0 ? unit / pos.entryPrice * 100 >= t.startPct : profit >= t.startUsd || profit >= t.startR * risk;
  if (!armed) return null;

  const strong = market?.regime === "uptrend" && (market.adx ?? 0) >= 25;
  let lock = t.lockFraction;
  const why = [];
  if (strong) { lock = Math.max(0.5, lock - 0.15); why.push("starker Aufwärtstrend → mehr Spielraum, der Trend darf laufen"); }
  else if (market) { lock = Math.min(0.9, lock + 0.1); why.push(`Marktphase ${market.regime ?? "unklar"} → mehr Gewinn sichern`); }
  const out = { profit, lock, why, stop: null, takeProfit: null };

  const wanted = pos.entryPrice + lock * unit, ceiling = price - 0.5 * atrValue, floor = pos.entryPrice * (1 + costFrac);
  const stop = Math.min(wanted, ceiling);
  if (stop >= floor && stop > pos.stop + 0.1 * atrValue) {
    out.stop = stop;
    out.lockedUsd = (stop - pos.entryPrice) * pos.amount;
    if (stop < wanted) why.push("Abstand zum Kurs mindestens 0,5 ATR (sonst Ausstoppen durch Rauschen)");
  }
  const ext = pos.tpExtensions || 0;
  if (t.extendTp && strong && ext < TRAIL_MAX_TP_EXTENSIONS && price >= pos.entryPrice + 0.8 * (pos.takeProfit - pos.entryPrice) && pos.entryPrice > initStop) {
    out.takeProfit = pos.takeProfit + (pos.entryPrice - initStop);
    why.push("Kurs nahe am Ziel bei starkem Trend → Ziel um 1R angehoben");
  }
  return out.stop == null && out.takeProfit == null ? null : out;
}
