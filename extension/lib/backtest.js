// Backtester inkl. Gebühren und Slippage (Port von tradingbot/backtest.py).
// Signale entstehen am Schluss einer Kerze und werden zur Eröffnung der nächsten ausgeführt (kein Look-ahead).
// Liegen Stop und Ziel in derselben Kerze, gilt konservativ der Stop als zuerst getroffen.
import { atr, regimeSeries } from "./indicators.js";
import { positionSize, stopAndTarget } from "./risk.js";
import { timeframeSeconds } from "./util.js";

export const WARMUP = 60;

export function runBacktest(cfg, df, strategy, initial = cfg.capital.start) {
  const n = df.close.length;
  if (n <= WARMUP + 2) throw new Error(`Zu wenige Kerzen für den Backtest: ${n}`);
  const fee = cfg.costs.feePct / 100, slip = cfg.costs.slippagePct / 100;
  const entrySig = strategy.entry(df), exitSig = strategy.exit(df);
  const regimeOk = regimeSeries(df).map((r) => strategy.regimes.includes(r));
  const atrArr = atr(df, cfg.risk.atrPeriod);
  // strategieeigene Ausstiegsabstände (stop_mult, rr) überschreiben die globalen Werte
  const risk = { ...cfg.risk, atrStopMult: strategy.stopMult?.(cfg.risk.atrStopMult) ?? cfg.risk.atrStopMult,
    takeProfitRr: strategy.rr?.(cfg.risk.takeProfitRr) ?? cfg.risk.takeProfitRr };
  const { open: o, high: h, low: l, close: c } = df;

  let cash = initial, amount = 0, entryPx = 0, stop = 0, tp = 0, costBasis = 0, entryI = 0;
  const trades = [], equity = new Array(n).fill(initial);

  const closePosition = (i, px, reason) => {
    const proceeds = amount * px * (1 - fee);
    trades.push({ entryTime: df.t[entryI], exitTime: df.t[i], entryPrice: entryPx, exitPrice: px, amount, pnl: proceeds - costBasis, reason });
    cash += proceeds;
    amount = 0;
  };

  for (let i = WARMUP; i < n; i++) {
    if (amount > 0 && exitSig[i - 1]) {
      closePosition(i, o[i] * (1 - slip), "signal");
    } else if (amount === 0 && entrySig[i - 1] && regimeOk[i - 1] && Number.isFinite(atrArr[i - 1])) {
      const px = o[i] * (1 + slip);
      const [stop_, tp_] = stopAndTarget(px, atrArr[i - 1], risk);
      const size = stop_ > 0 ? positionSize(cash, cash, px, stop_, cfg.risk, cfg.costs) : 0;
      if (size > 0) {
        amount = size; entryPx = px; stop = stop_; tp = tp_; entryI = i;
        costBasis = amount * px * (1 + fee);
        cash -= costBasis;
      }
    }
    if (amount > 0) {
      if (l[i] <= stop) closePosition(i, Math.min(stop, o[i]) * (1 - slip), "stop_loss");
      else if (h[i] >= tp) closePosition(i, Math.max(tp, 0) * (1 - slip), "take_profit");
    }
    equity[i] = cash + amount * c[i];
  }
  if (amount > 0) { closePosition(n - 1, c[n - 1] * (1 - slip), "end_of_data"); equity[n - 1] = cash; }
  return { strategy: strategy.name, metrics: computeMetrics(cfg, equity, trades, initial), trades, equity };
}

function computeMetrics(cfg, equityFull, trades, initial) {
  const eq = equityFull.slice(WARMUP);
  const rets = [];
  for (let i = 1; i < eq.length; i++) rets.push(eq[i] / eq[i - 1] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const std = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
  const barsPerYear = (365 * 86400) / timeframeSeconds(cfg.timeframe);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(barsPerYear) : 0;
  let peak = -Infinity, dd = 0;
  for (const v of eq) { peak = Math.max(peak, v); dd = Math.min(dd, v / peak - 1); }
  const wins = trades.filter((t) => t.pnl > 0).map((t) => t.pnl);
  const losses = trades.filter((t) => t.pnl <= 0).map((t) => -t.pnl);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const profitFactor = losses.length && sum(losses) > 0 ? Math.min(sum(wins) / sum(losses), 999) : wins.length ? 999 : 0;
  const split = Math.trunc(eq.length * (1 - cfg.backtest.oosFraction));
  const oos = split < eq.length ? (eq[eq.length - 1] / eq[split] - 1) * 100 : 0;
  return {
    return_pct: (eq[eq.length - 1] / initial - 1) * 100,
    max_drawdown_pct: -dd * 100,
    sharpe,
    win_rate_pct: trades.length ? (wins.length / trades.length) * 100 : 0,
    profit_factor: profitFactor,
    trades: trades.length,
    oos_return_pct: oos,
  };
}

// Prüft die Mindestwerte; gibt { ok, failures } zurück.
export function checkThresholds(m, bt) {
  const checks = [
    [m.trades >= bt.minTrades, `Trades ${m.trades} < ${bt.minTrades}`],
    [m.return_pct >= bt.minReturnPct, `Rendite ${m.return_pct.toFixed(2)}% < ${bt.minReturnPct}%`],
    [m.max_drawdown_pct <= bt.maxDrawdownPct, `Max Drawdown ${m.max_drawdown_pct.toFixed(2)}% > ${bt.maxDrawdownPct}%`],
    [m.sharpe >= bt.minSharpe, `Sharpe ${m.sharpe.toFixed(2)} < ${bt.minSharpe}`],
    [m.win_rate_pct >= bt.minWinRatePct, `Trefferquote ${m.win_rate_pct.toFixed(1)}% < ${bt.minWinRatePct}%`],
    [m.profit_factor >= bt.minProfitFactor, `Profit Factor ${m.profit_factor.toFixed(2)} < ${bt.minProfitFactor}`],
    [m.oos_return_pct >= bt.minOosReturnPct, `Out-of-Sample-Rendite ${m.oos_return_pct.toFixed(2)}% < ${bt.minOosReturnPct}%`],
  ];
  const failures = checks.filter(([ok]) => !ok).map(([, msg]) => msg);
  return { ok: failures.length === 0, failures };
}
