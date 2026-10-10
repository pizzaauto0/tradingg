// Hauptlogik pro Durchlauf (Port von tradingbot/engine.py, ein Symbol: SOL/USD).
import { atr, classifyMarket, summarize } from "./indicators.js";
import { buildStrategy } from "./strategies.js";
import { positionSize, RiskManager, stopAndTarget } from "./risk.js";
import { selectStrategy } from "./pipeline.js";
import { timeframeSeconds } from "./util.js";

export const SYMBOL = "SOL/USD";
const MIN_NOTIONAL_USD = 5;

const floorTo = (x, d) => Math.floor(x * 10 ** d) / 10 ** d;
const last = (x) => x[x.length - 1];

// deps: { cfg, state, broker, fetchRecent(), notify(text), logTrade(row), save(), refresher() }
export class Engine {
  constructor(deps) {
    Object.assign(this, deps);
    this.risk = new RiskManager(this.cfg, this.state);
    this.state.positions ||= {};
    this.lastPrice = null;
    this.exitedThisTick = false;
  }

  get position() { return this.state.positions[SYMBOL] || null; }

  async equity() {
    let v = await this.broker.cash();
    const p = this.position;
    if (p) v += p.amount * (this.lastPrice ?? p.entryPrice);
    return v;
  }

  async tick(now = new Date()) {
    const { state } = this;
    if (state.pending) {
      state.enabled = false;
      await this.save();
      await this.notify(`WARNUNG: Unklarer Orderstatus (${state.pending.what}). Bot gestoppt – bitte Wallet prüfen und Status zurücksetzen.`);
      return;
    }
    if (state.killRequested) { await this.kill(now); return; }
    await this.maybeRefresh(now);
    this.exitedThisTick = false;

    const live = await this.fetchRecent();
    const tfMs = timeframeSeconds(this.cfg.timeframe) * 1000;
    const n = live.t.length;
    const forming = live.t[n - 1] + tfMs > now.getTime();
    const closed = forming ? sliceFrame(live, 0, n - 1) : live;
    if (closed.t.length < 150) { console.warn("Zu wenige geschlossene Kerzen"); return; }
    this.lastPrice = last(live.close);

    const stamp = last(closed.t);
    const isNew = state.lastCandle != null && state.lastCandle !== stamp;
    if (state.lastCandle == null) state.lastCandle = stamp; // beim ersten Sehen nicht auf alte Signale reagieren

    if (this.broker.mode === "live" && this.position) await this.reconcile();
    this.risk.rollDay(now, await this.equity());
    await this.managePositions(closed, live, isNew, now);

    const equity = await this.equity();
    if (this.risk.checkDailyLimit(equity)) {
      await this.notify(`Tagesverlust-Limit erreicht (${this.risk.dailyPnlPct(equity).toFixed(2)}%). Kein Handel bis zum nächsten UTC-Tag.`);
      if (this.cfg.risk.closePositionsOnDailyLimit) await this.flatten("Tagesverlust-Limit", now);
    }
    if (!this.risk.halted) await this.lookForEntries(closed, live, isNew, now);

    state.lastCandle = stamp;
    await this.save();
  }

  // ---- Positionen ----
  async managePositions(closed, live, isNew, now) {
    const pos = this.position;
    if (!pos) return;
    const price = last(live.close), tfMs = timeframeSeconds(this.cfg.timeframe) * 1000;
    const entryCandle = Math.floor(Date.parse(pos.openedAt) / tfMs) * tfMs;
    let low = price;
    for (let i = 0; i < live.t.length; i++) if (live.t[i] > entryCandle) low = Math.min(low, live.low[i]);

    let fill = null;
    if (low <= pos.stop) { // Stop erreicht -> Verkauf; währenddessen als "unklar" markieren, falls der Browser dabei beendet wird
      this.state.pending = { what: `Stop-Verkauf ${SYMBOL}`, ts: now.toISOString() };
      await this.save();
      try { fill = await this.broker.checkStop(pos, low, price); }
      catch (e) { this.state.pending = null; await this.save(); throw e; }
      this.state.pending = null;
    }
    if (fill) return this.recordExit(pos, fill, `Stop-Loss bei ${pos.stop.toFixed(2)} ausgelöst`, now);
    if (price >= pos.takeProfit) return this.close(pos, price, `Take-Profit ${pos.takeProfit.toFixed(2)} erreicht`, now);
    if (isNew && buildStrategy(pos.strategySpec).exit(closed).at(-1)) {
      return this.close(pos, price, `Ausstiegssignal der Strategie ${pos.strategyName}`, now);
    }
  }

  async close(pos, refPrice, reason, now) {
    this.state.pending = { what: `Verkauf ${SYMBOL}`, ts: now.toISOString() };
    await this.save();
    let fill;
    try { fill = await this.broker.closeLong(pos, refPrice); }
    catch (e) { this.state.pending = null; await this.save(); throw e; }
    this.state.pending = null;
    await this.recordExit(pos, fill, reason, now);
  }

  async recordExit(pos, fill, reason, now) {
    const pnl = (fill.price - pos.entryPrice) * fill.amount - pos.entryFee - fill.fee;
    delete this.state.positions[SYMBOL];
    this.exitedThisTick = true; // kein Wiedereinstieg im selben Durchlauf
    await this.save();
    await this.logTrade({ ts: now.toISOString(), mode: this.broker.mode, symbol: SYMBOL, action: "EXIT", price: fill.price,
      amount: fill.amount, fee: fill.fee, pnl, strategy: pos.strategyName, regime: pos.regime, reason, equity: await this.equity() });
    await this.notify(`EXIT ${SYMBOL} @ ${fill.price.toFixed(2)} | PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} | ${reason}`);
  }

  async flatten(reason, now) {
    const pos = this.position;
    if (!pos) return;
    try { await this.close(pos, this.lastPrice ?? pos.entryPrice, reason, now); }
    catch (e) { await this.notify(`WARNUNG: ${SYMBOL} konnte nicht geschlossen werden: ${e.message}`); }
  }

  async kill(now) {
    await this.notify("NOT-AUS aktiv – Position wird geschlossen, Bot gestoppt.");
    try { this.lastPrice = last((await this.fetchRecent()).close); } catch { /* alten Kurs nutzen */ }
    await this.flatten("Not-Aus", now);
    this.state.enabled = false;
    if (!this.position) this.state.killRequested = false;
    else await this.notify(`WARNUNG: ${SYMBOL} nicht geschlossen – bitte manuell prüfen! Not-Aus bleibt aktiv.`);
    await this.save();
  }

  // Live: Position, die in der Wallet nicht mehr existiert (z. B. manuell verkauft), aus dem Zustand entfernen.
  async reconcile() {
    const pos = this.position, have = await this.broker.baseBalance();
    if (pos && have < pos.amount * 0.99) {
      await this.notify(`${SYMBOL}: Position in der Wallet nicht mehr vorhanden (${have.toFixed(4)} < ${pos.amount.toFixed(4)}) – aus dem Zustand entfernt. Bitte Trade-Log prüfen.`);
      delete this.state.positions[SYMBOL];
      await this.save();
    }
  }

  // ---- Einstiege ----
  async lookForEntries(closed, live, isNew, now) {
    if (this.position || this.exitedThisTick || !isNew) return;
    const [ok, why] = this.risk.canOpen(Object.keys(this.state.positions).length);
    if (!ok) { console.info("Kein Einstieg:", why); return; }
    const market = classifyMarket(closed);
    const sel = selectStrategy(this.state.approved || [], this.cfg.timeframe, market);
    if (!sel) { console.info(`Keine zugelassene Strategie für Marktphase ${market.regime}`); return; }
    const { strategy } = sel;
    if (!strategy.entry(closed).at(-1)) return;

    const price = last(live.close), atrValue = last(atr(closed, this.cfg.risk.atrPeriod));
    const [stop, takeProfit] = stopAndTarget(price, atrValue, this.cfg.risk);
    if (stop <= 0) { console.warn("ATR unbrauchbar, kein Einstieg"); return; }
    const equity = await this.equity();
    const raw = positionSize(this.risk.sizingEquity(equity), await this.broker.cash(), price, stop, this.cfg.risk, this.cfg.costs);
    const amount = floorTo(raw, 6);
    if (amount * price < MIN_NOTIONAL_USD) { console.info(`Positionsgröße unter Minimum (${(amount * price).toFixed(2)} USD)`); return; }

    const riskCash = amount * (price - stop);
    const reason = `${strategy.explain(closed)}; Marktphase: ${summarize(market)}; Stop ${stop.toFixed(2)} ` +
      `(${this.cfg.risk.atrStopMult}x ATR), Ziel ${takeProfit.toFixed(2)}; Risiko ca. ${riskCash.toFixed(2)} ` +
      `(${((riskCash / equity) * 100).toFixed(2)}% des Kapitals); Backtest-Sharpe ${(sel.record.metrics?.sharpe ?? 0).toFixed(2)}`;

    this.state.pending = { what: `Kauf ${SYMBOL}`, ts: now.toISOString() };
    await this.save();
    let fill;
    try { fill = await this.broker.openLong(amount, stop, price); }
    catch (e) { this.state.pending = null; await this.save(); await this.notify(`${SYMBOL}: Order fehlgeschlagen: ${e.message}`); return; }
    this.state.positions[SYMBOL] = {
      symbol: SYMBOL, amount: fill.amount, entryPrice: fill.price, stop, takeProfit, entryFee: fill.fee,
      openedAt: now.toISOString(), strategySpec: strategy.toSpec(), strategyName: strategy.name, regime: market.regime, reason,
    };
    this.state.pending = null;
    this.lastPrice = price;
    await this.save(); // Position sofort sichern
    await this.logTrade({ ts: now.toISOString(), mode: this.broker.mode, symbol: SYMBOL, action: "ENTRY", price: fill.price,
      amount: fill.amount, fee: fill.fee, pnl: null, strategy: strategy.name, regime: market.regime, reason, equity: await this.equity() });
    await this.notify(`ENTRY ${SYMBOL} ${fill.amount.toFixed(4)} @ ${fill.price.toFixed(2)} | Stop ${stop.toFixed(2)} | ${strategy.name} | ${market.regime}`);
  }

  // ---- Strategien neu prüfen ----
  async maybeRefresh(now) {
    const ageH = this.state.lastRefresh ? (now - Date.parse(this.state.lastRefresh)) / 3.6e6 : Infinity;
    if (ageH < this.cfg.pipeline.revalidateHours) return;
    try {
      const res = await this.refresher();
      this.state.approved = res.approved;
      this.state.report = res.report;
      await this.notify(`Strategien neu geprüft: ${res.approved.length} zugelassen`);
    } catch (e) {
      await this.notify(`Neuprüfung der Strategien fehlgeschlagen: ${e.message}`);
    }
    this.state.lastRefresh = now.toISOString();
  }
}

export function sliceFrame(df, a, b) {
  const out = {};
  for (const k of Object.keys(df)) out[k] = df[k].slice(a, b);
  return out;
}
