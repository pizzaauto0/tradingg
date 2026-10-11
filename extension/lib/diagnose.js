// Diagnose: warum hat der Bot keine Strategie zugelassen? (reine Funktionen, ohne Browser-Abhängigkeiten)

const REASONS = [
  ["Trades", "zu wenige Trades im Testzeitraum"],
  ["Rendite", "Rendite zu niedrig / Verlust"],
  ["Max Drawdown", "zu hoher Drawdown"],
  ["Sharpe", "Sharpe Ratio zu niedrig"],
  ["Trefferquote", "Trefferquote zu niedrig"],
  ["Profit Factor", "Profit Factor zu niedrig"],
  ["Out-of-Sample", "Verlust auf den zuletzt ungesehenen Daten"],
];

// Zählt, woran die abgelehnten Strategien scheiterten (eine Strategie kann an mehreren Punkten scheitern).
export function summarizeFailures(report) {
  const rejected = report.filter((r) => !r.approved);
  const byReason = REASONS.map(([key, label]) => ({
    label, count: rejected.filter((r) => r.failures.some((f) => f.startsWith(key))).length,
  })).filter((r) => r.count > 0).sort((a, b) => b.count - a.count);
  const profitable = report.filter((r) => r.metrics.return_pct > 0).length;
  const highWin = report.filter((r) => r.metrics.win_rate_pct >= 55).length;
  return { total: report.length, rejected: rejected.length, byReason, profitable, highWin };
}

// Die "knapp gescheiterten": wenigste Verstöße, bei Gleichstand höchste Sharpe Ratio.
export function nearMisses(report, n = 5) {
  return report.filter((r) => !r.approved)
    .sort((a, b) => a.failures.length - b.failures.length || b.metrics.sharpe - a.metrics.sharpe)
    .slice(0, n);
}
