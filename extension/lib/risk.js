// Risikomanagement (Port von tradingbot/risk.py). Hat Vorrang vor allem anderen.

export function stopAndTarget(entry, atrValue, risk) {
  const dist = atrValue * risk.atrStopMult;
  if (!(dist > 0) || entry - dist <= 0) return [0, 0];
  return [entry - dist, entry + dist * risk.takeProfitRr];
}

// Positionsgröße: Stop-Out kostet inkl. Gebühren/Slippage höchstens riskPerTradePct; zusätzlich Deckel durch
// maxPositionPct und verfügbares Bargeld (kein Hebel).
export function positionSize(equity, cash, entry, stop, risk, costs) {
  if (stop <= 0 || entry <= stop) return 0;
  const cost = (costs.feePct + costs.slippagePct) / 100;
  const perUnitRisk = (entry - stop) + (entry + stop) * cost;
  let amount = (equity * risk.riskPerTradePct) / 100 / perUnitRisk;
  amount = Math.min(amount, (equity * risk.maxPositionPct) / 100 / entry);
  // Kauf kostet entry * (1 + slippage) * (1 + fee) je Einheit (multiplikativ, nicht additiv)
  amount = Math.min(amount, cash / (entry * (1 + costs.slippagePct / 100) * (1 + costs.feePct / 100)));
  return Math.max(amount, 0);
}

// Tageslimit und Positionslimit; Zustand liegt in state.risk.
export class RiskManager {
  constructor(cfg, state) {
    this.cfg = cfg;
    this.r = cfg.risk;
    this.s = state.risk = state.risk || {};
  }
  rollDay(now, equity) {
    const day = now.toISOString().slice(0, 10);
    if (this.s.day !== day) Object.assign(this.s, { day, startEquity: equity, halted: false });
  }
  get halted() { return !!this.s.halted; }
  dailyPnlPct(equity) { const start = this.s.startEquity || equity; return (equity / start - 1) * 100; }
  checkDailyLimit(equity) {
    if (this.halted) return false;
    if (this.dailyPnlPct(equity) <= -this.r.maxDailyLossPct) { this.s.halted = true; return true; }
    return false;
  }
  canOpen(nOpen) {
    if (this.halted) return [false, "Tagesverlust-Limit erreicht – kein Handel bis zum nächsten UTC-Tag"];
    if (nOpen >= this.r.maxOpenPositions) return [false, `Maximale Anzahl offener Positionen erreicht (${this.r.maxOpenPositions})`];
    return [true, ""];
  }
  // Live: nie mehr als das konfigurierte Kapital einsetzen.
  sizingEquity(equity) { return this.cfg.liveTrading ? Math.min(equity, this.cfg.capital.start) : equity; }
}
