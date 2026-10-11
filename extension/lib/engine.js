// Hauptlogik pro Durchlauf (Port von tradingbot/engine.py), mehrere Märkte gleichzeitig (SOL, BTC, ETH, je USD).
import { atr, classifyMarket, summarize } from "./indicators.js";
import { buildStrategy } from "./strategies.js";
import { positionSize, RiskManager, stopAndTarget } from "./risk.js";
import { selectStrategy } from "./pipeline.js";
import { timeframeSeconds } from "./util.js";
import { symbolOf } from "./config.js";

const MIN_NOTIONAL_USD = 5;
const floorTo = (x, d) => Math.floor(x * 10 ** d) / 10 ** d;
const last = (x) => x[x.length - 1];

// deps: { cfg, state, broker, fetchRecent(symbol), notify(text), logTrade(row), save(), refresher() }
export class Engine {
  constructor(deps) {
    Object.assign(this, deps);
    this.risk = new RiskManager(this.cfg, this.state);
    this.state.positions ||= {};
    if (typeof this.state.lastCandle !== "object" || this.state.lastCandle === null) this.state.lastCandle = {};
    this.state.activity = this.state.activity && !("price" in this.state.activity) ? this.state.activity : {};
    this.symbols = this.cfg.assets.map(symbolOf);
    this.lastPrices = {};
    this.exitedThisTick = new Set();
  }

  async equity() {
    let v = await this.broker.cash();
    for (const [sym, p] of Object.entries(this.state.positions)) v += p.amount * (this.lastPrices[sym] ?? p.entryPrice);
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
    this.exitedThisTick.clear();
    const tfMs = timeframeSeconds(this.cfg.timeframe) * 1000;

    // 1) Daten laden; ein ausgefallener Markt stoppt die anderen nicht
    const data = {};
    for (const sym of this.symbols) {
      try {
        const live = await this.fetchRecent(sym);
        const n = live.t.length, forming = live.t[n - 1] + tfMs > now.getTime();
        const closed = forming ? sliceFrame(live, 0, n - 1) : live;
        if (closed.t.length < 150) { console.warn(`${sym}: zu wenige geschlossene Kerzen`); continue; }
        const stamp = last(closed.t);
        const prev = state.lastCandle[sym];
        data[sym] = { live, closed, stamp, isNew: prev != null && prev !== stamp };
        if (prev == null) state.lastCandle[sym] = stamp; // beim ersten Sehen nicht auf alte Signale reagieren
        this.lastPrices[sym] = last(live.close);
      } catch (e) {
        state.activity[sym] = { ts: now.toISOString(), error: e.message };
        console.warn(`${sym}: Daten nicht ladbar: ${e.message}`);
      }
    }
    if (!Object.keys(data).length) throw new Error("Keine Marktdaten erhalten");
    this.broker.hintPrices?.(this.lastPrices);

    // 2) Offene Positionen verwalten (Stop, Ziel, Ausstiegssignal)
    if (this.broker.mode === "live" && Object.keys(state.positions).length) await this.reconcile();
    this.risk.rollDay(now, await this.equity());
    for (const [sym, d] of Object.entries(data)) await this.managePosition(sym, d, now);

    // 3) Tageslimit über alle Märkte
    const equity = await this.equity();
    if (this.risk.checkDailyLimit(equity)) {
      await this.notify(`Tagesverlust-Limit erreicht (${this.risk.dailyPnlPct(equity).toFixed(2)}%). Kein Handel bis zum nächsten UTC-Tag.`);
      if (this.cfg.risk.closePositionsOnDailyLimit) await this.flatten("Tagesverlust-Limit", now);
    }

    // 4) Beobachten und ggf. einsteigen
    for (const [sym, d] of Object.entries(data)) {
      const obs = this.observe(sym, d, now, tfMs);
      if (!this.risk.halted) await this.lookForEntry(sym, d, now, obs);
      state.lastCandle[sym] = d.stamp;
    }
    await this.save();
  }

  // ---- Positionen ----
  async managePosition(sym, { closed, live, isNew }, now) {
    const pos = this.state.positions[sym];
    if (!pos) return;
    const price = last(live.close), tfMs = timeframeSeconds(this.cfg.timeframe) * 1000;
    const entryCandle = Math.floor(Date.parse(pos.openedAt) / tfMs) * tfMs;
    let low = price;
    for (let i = 0; i < live.t.length; i++) if (live.t[i] > entryCandle) low = Math.min(low, live.low[i]);

    let fill = null;
    if (low <= pos.stop) { // Stop erreicht -> Verkauf; währenddessen als "unklar" markieren, falls der Browser dabei beendet wird
      this.state.pending = { what: `Stop-Verkauf ${sym}`, ts: now.toISOString() };
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
    this.state.pending = { what: `Verkauf ${pos.symbol}`, ts: now.toISOString() };
    await this.save();
    let fill;
    try { fill = await this.broker.closeLong(pos, refPrice); }
    catch (e) { this.state.pending = null; await this.save(); throw e; }
    this.state.pending = null;
    await this.recordExit(pos, fill, reason, now);
  }

  async recordExit(pos, fill, reason, now) {
    const pnl = (fill.price - pos.entryPrice) * fill.amount - pos.entryFee - fill.fee;
    delete this.state.positions[pos.symbol];
    this.exitedThisTick.add(pos.symbol); // kein Wiedereinstieg im selben Durchlauf
    await this.save();
    await this.logTrade({ ts: now.toISOString(), mode: this.broker.mode, symbol: pos.symbol, action: "EXIT", price: fill.price,
      amount: fill.amount, fee: fill.fee, pnl, strategy: pos.strategyName, regime: pos.regime, reason, equity: await this.equity() });
    await this.notify(`EXIT ${pos.symbol} @ ${fill.price.toFixed(2)} | PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} | ${reason}`);
  }

  async flatten(reason, now) {
    for (const pos of Object.values(this.state.positions)) {
      try { await this.close(pos, this.lastPrices[pos.symbol] ?? pos.entryPrice, reason, now); }
      catch (e) { await this.notify(`WARNUNG: ${pos.symbol} konnte nicht geschlossen werden: ${e.message}`); }
    }
  }

  async kill(now) {
    await this.notify("NOT-AUS aktiv – alle Positionen werden geschlossen, Bot gestoppt.");
    for (const sym of Object.keys(this.state.positions)) {
      try { this.lastPrices[sym] = last((await this.fetchRecent(sym)).close); } catch { /* alten Kurs nutzen */ }
    }
    await this.flatten("Not-Aus", now);
    this.state.enabled = false;
    const left = Object.keys(this.state.positions);
    if (!left.length) this.state.killRequested = false;
    else await this.notify(`WARNUNG: Nicht geschlossen: ${left.join(", ")} – bitte manuell prüfen! Not-Aus bleibt aktiv.`);
    await this.save();
  }

  // Live: Positionen, die in der Wallet nicht mehr existieren (z. B. manuell verkauft), aus dem Zustand entfernen.
  async reconcile() {
    for (const pos of Object.values(this.state.positions)) {
      const have = await this.broker.baseBalance(pos.symbol);
      if (have < pos.amount * 0.99) {
        await this.notify(`${pos.symbol}: Position in der Wallet nicht mehr vorhanden (${have.toFixed(4)} < ${pos.amount.toFixed(4)}) – aus dem Zustand entfernt. Bitte Trade-Log prüfen.`);
        delete this.state.positions[pos.symbol];
        await this.save();
      }
    }
  }

  // ---- Sichtbarkeit: was der Bot gerade sieht und entscheidet (für die Anzeige im Popup) ----
  observe(sym, { closed, live, isNew, stamp }, now, tfMs) {
    let market = null, sel = null, signal = null, note = "";
    try {
      market = classifyMarket(closed);
      sel = selectStrategy(this.state.approved || [], sym, this.cfg.timeframe, market);
      signal = sel ? !!sel.strategy.entry(closed).at(-1) : null;
    } catch (e) { note = e.message; }
    this.state.activity[sym] = {
      ts: now.toISOString(), price: last(live.close), regime: market?.regime ?? null, volatility: market?.volatility ?? null,
      adx: market?.adx ?? null, strategy: sel?.strategy.name ?? null, signal, nextCandleAt: stamp + 2 * tfMs, note,
    };
    if (isNew) {
      const what = !market ? `Analyse nicht möglich (${note})`
        : !sel ? `${market.regime}: keine zugelassene Strategie für diese Marktphase → warte`
        : `${market.regime}: ${sel.strategy.name} → Signal ${signal ? "JA" : "nein"}`;
      const log = this.state.decisions ||= [];
      log.push({ ts: now.toISOString(), symbol: sym, text: `${sym} · Kerze geprüft · ${what}${this.state.positions[sym] ? " · Position offen" : ""}${this.risk.halted ? " · Tageslimit aktiv" : ""}` });
      this.state.decisions = log.slice(-40);
    }
    return { market, sel, signal };
  }

  // ---- Einstiege ----
  async lookForEntry(sym, { closed, live, isNew }, now, obs) {
    if (this.state.positions[sym] || this.exitedThisTick.has(sym) || !isNew) return;
    const [ok, why] = this.risk.canOpen(Object.keys(this.state.positions).length);
    if (!ok) { console.info("Kein Einstieg:", why); return; }
    const { market, sel, signal } = obs;
    if (!market || !sel || !signal) return;
    const { strategy } = sel;

    const price = last(live.close), atrValue = last(atr(closed, this.cfg.risk.atrPeriod));
    const risk = { ...this.cfg.risk, atrStopMult: strategy.stopMult(this.cfg.risk.atrStopMult), takeProfitRr: strategy.rr(this.cfg.risk.takeProfitRr) };
    const [stop, takeProfit] = stopAndTarget(price, atrValue, risk);
    if (stop <= 0) { console.warn(`${sym}: ATR unbrauchbar, kein Einstieg`); return; }
    const equity = await this.equity();
    const raw = positionSize(this.risk.sizingEquity(equity), await this.broker.cash(), price, stop, this.cfg.risk, this.cfg.costs);
    const amount = floorTo(raw, price > 1000 ? 6 : 5);
    if (amount * price < MIN_NOTIONAL_USD) { console.info(`${sym}: Positionsgröße unter Minimum (${(amount * price).toFixed(2)} USD)`); return; }

    const riskCash = amount * (price - stop);
    const reason = `${sel.record.explore ? "EXPERIMENTELL (Erkundungsmodus – Strategie hat die strengen Prüfungen NICHT bestanden): " : ""}${strategy.explain(closed)}; Marktphase: ${summarize(market)}; Stop ${stop.toFixed(2)} ` +
      `(${risk.atrStopMult}x ATR), Ziel ${takeProfit.toFixed(2)}; Risiko ca. ${riskCash.toFixed(2)} ` +
      `(${((riskCash / equity) * 100).toFixed(2)}% des Kapitals); Backtest: Sharpe ${(sel.record.metrics?.sharpe ?? 0).toFixed(2)}, Trefferquote ${(sel.record.metrics?.win_rate_pct ?? 0).toFixed(1)}%`;

    this.state.pending = { what: `Kauf ${sym}`, ts: now.toISOString() };
    await this.save();
    let fill;
    try { fill = await this.broker.openLong(sym, amount, stop, price); }
    catch (e) { this.state.pending = null; await this.save(); await this.notify(`${sym}: Order fehlgeschlagen: ${e.message}`); return; }
    this.state.positions[sym] = {
      symbol: sym, amount: fill.amount, entryPrice: fill.price, stop, takeProfit, entryFee: fill.fee,
      openedAt: now.toISOString(), strategySpec: strategy.toSpec(), strategyName: strategy.name, regime: market.regime, reason,
    };
    this.state.pending = null;
    this.lastPrices[sym] = price;
    await this.save(); // Position sofort sichern
    await this.logTrade({ ts: now.toISOString(), mode: this.broker.mode, symbol: sym, action: "ENTRY", price: fill.price,
      amount: fill.amount, fee: fill.fee, pnl: null, strategy: strategy.name, regime: market.regime, reason, equity: await this.equity() });
    await this.notify(`ENTRY ${sym} ${fill.amount.toFixed(5)} @ ${fill.price.toFixed(2)} | Stop ${stop.toFixed(2)} | ${strategy.name} | ${market.regime}`);
  }

  // ---- Strategien neu prüfen ----
  async maybeRefresh(now) {
    const ageH = this.state.lastRefresh ? (now - Date.parse(this.state.lastRefresh)) / 3.6e6 : Infinity;
    if (ageH < this.cfg.pipeline.revalidateHours) return;
    this.state.status = "Strategien werden recherchiert und gebacktestet …";
    await this.save();
    try {
      const res = await this.refresher();
      this.state.approved = res.approved;
      this.state.report = res.report;
      await this.notify(`Strategien neu geprüft: ${res.approved.length} zugelassen, ${res.approved.filter((a) => a.active).length} aktiv${res.problems?.length ? ` (Probleme: ${res.problems.join("; ")})` : ""}`);
    } catch (e) {
      await this.notify(`Neuprüfung der Strategien fehlgeschlagen: ${e.message}`);
    }
    this.state.lastRefresh = now.toISOString();
    this.state.status = null;
  }
}

export function sliceFrame(df, a, b) {
  const out = {};
  for (const k of Object.keys(df)) out[k] = df[k].slice(a, b);
  return out;
}
