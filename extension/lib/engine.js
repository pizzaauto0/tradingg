// Hauptlogik pro Durchlauf (Port von tradingbot/engine.py), mehrere Märkte gleichzeitig (SOL, BTC, ETH, je USD).
import { atr, classifyMarket, ema, summarize } from "./indicators.js";
import { buildStrategy } from "./strategies.js";
import { positionSize, RiskManager, stopAndTarget } from "./risk.js";
import { selectStrategy } from "./pipeline.js";
import { fmtPx, timeframeSeconds } from "./util.js";
import { planTrail } from "./trail.js";
import { ago, stamp as stampTxt, strategyLabel } from "./names.js";

const REGIME_DE = { uptrend: "Aufwärts", downtrend: "Abwärts", sideways: "Seitwärts" };
const pctOf = (to, from) => `${to >= from ? "+" : ""}${(((to / from) - 1) * 100).toFixed(1)} %`;
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

  // Eigenkapital = Bargeld + Wert der eigenen Positionen + (bei gemeinsamem Paper-Konto) Wert der Positionen der anderen Bots.
  // Den eigenen Positionswert merkt sich das Konto, damit die anderen Bots ihn kennen.
  log(level, text) { this.notify?.log?.(text, level); }   // Protokoll-Kanal (Discord), siehe controller.makeNotifier

  async equity() {
    let own = 0;
    for (const [sym, p] of Object.entries(this.state.positions)) own += p.amount * (this.lastPrices[sym] ?? p.entryPrice);
    let v = (await this.broker.cash()) + own;
    const values = this.broker.s?.values;
    if (values && this.botId) {
      values[this.botId] = own;
      for (const [id, x] of Object.entries(values)) if (id !== this.botId) v += x;
    }
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
    // Märkte, für die der Scan keine Kursdaten fand, werden nicht jede halbe Minute erneut abgefragt (außer bei offener Position)
    const noData = new Set((state.problems || []).map((p) => p.split(":")[0]));
    for (const sym of this.symbols.filter((s) => !noData.has(s) || state.positions[s])) {
      try {
        const live = await this.fetchRecent(sym);
        const n = live.t.length, forming = live.t[n - 1] + tfMs > now.getTime();
        const closed = forming ? sliceFrame(live, 0, n - 1) : live;
        if (closed.t.length < 150) { console.warn(`${sym}: zu wenige geschlossene Kerzen`); continue; }
        const stamp = last(closed.t);
        const prev = state.lastCandle[sym];
        data[sym] = { live, closed, stamp, isNew: prev != null && prev !== stamp };
        if (prev == null) state.lastCandle[sym] = stamp; // beim ersten Sehen nicht auf alte Signale reagieren
        if (prev == null || prev !== stamp) (state.seenAt ||= {})[sym] = now.toISOString();   // wann die Kerze bei uns ankam (Datenquellen liefern oft einige Minuten verspätet)
        this.lastPrices[sym] = last(live.close);
      } catch (e) {
        state.activity[sym] = { ts: now.toISOString(), error: e.message };
        console.warn(`${sym}: Daten nicht ladbar: ${e.message}`);
        this.log("warn", `${sym}: Daten nicht ladbar: ${e.message}`);
      }
    }
    if (!Object.keys(data).length) throw new Error("Keine Marktdaten erhalten");
    this.broker.hintPrices?.(this.lastPrices);

    // 2) Offene Positionen verwalten (Stop, Ziel, Ausstiegssignal)
    if (this.broker.mode === "live" && Object.keys(state.positions).length) await this.reconcile();
    this.risk.rollDay(now, await this.equity());
    for (const [sym, d] of Object.entries(data)) { await this.managePosition(sym, d, now); await this.manageTrail(sym, d, now); }

    // 3) Tageslimit über alle Märkte
    const equity = await this.equity();
    if (this.risk.checkDailyLimit(equity)) {
      await this.notify(`Tagesverlust-Limit erreicht (${this.risk.dailyPnlPct(equity).toFixed(2)}%). Kein Handel bis zum nächsten UTC-Tag.`);
      if (this.cfg.risk.closePositionsOnDailyLimit) await this.flatten("Tagesverlust-Limit", now);
    }

    // Marktbreite: wie viele Märkte dieses Bots liegen unter ihrer 50er-Linie (EMA50)? Bei einem breit fallenden Markt verlieren Long-Käufe meist
    { let n = 0, weak = 0; for (const d of Object.values(data)) { const v = last(ema(d.closed.close, 50)); if (Number.isFinite(v)) { n++; if (last(d.closed.close) < v) weak++; } } state.breadth = { n, weak, ts: now.toISOString() }; }

    // 4) Beobachten und ggf. einsteigen
    for (const [sym, d] of Object.entries(data)) {
      const obs = this.observe(sym, d, now, tfMs);
      if (!this.risk.halted) await this.lookForEntry(sym, d, now, obs);
      state.lastCandle[sym] = d.stamp;
    }
    await this.maybeHourly(now, equity);
    await this.save();
  }

  // ---- Stundenbericht: warum gekauft / warum nicht (geht nur an Discord) ----
  whyNot(sym) {
    const { state } = this, a = state.activity[sym];
    if (!a) return "noch keine Daten";
    if (a.error) return `Kursdaten nicht ladbar (${a.error})`;
    if (state.positions[sym]) return "Position ist offen (höchstens eine je Markt)";
    if ((state.problems || []).some((p) => p.startsWith(sym + ":"))) return "keine Kursdaten im Strategie-Scan";
    if (!a.regime) return `Marktanalyse nicht möglich${a.note ? " (" + a.note + ")" : ""}`;
    if (!a.strategy) {
      const any = (state.approved || []).some((r) => r.symbol === sym && r.active !== false);
      return any ? `keine aktive Strategie passt zur Marktphase „${a.regime}“` : "keine zugelassene Strategie (Backtest nicht bestanden) – der Bot wartet";
    }
    if (!a.signal) return `kein Einstiegssignal („${strategyLabel(a.strategy)}“)`;
    const blocked = state.entryBlocked?.[sym];
    if (blocked && Date.now() - Date.parse(blocked.ts) < 3 * 3.6e6) return `Signal vorhanden, aber kein Kauf: ${blocked.text}`;
    const [ok, why] = this.risk.canOpen(Object.keys(state.positions).length);
    if (this.risk.halted) return "Signal vorhanden, aber Tageslimit erreicht – kein Handel";
    if (this.isPaused(new Date())) return `Signal vorhanden, aber Kaufpause nach Verlustserie bis ${new Date(state.pauseUntil).toLocaleTimeString("de-DE")}`;
    if (!ok) return `Signal vorhanden, aber ${why}`;
    return "Signal vorhanden – Einstieg wird bei der nächsten geschlossenen Kerze ausgeführt oder wegen Positionsgröße/Guthaben abgelehnt";
  }

  async maybeHourly(now, equity) {
    const { state } = this;
    if (state.lastHourly && now - Date.parse(state.lastHourly) < 3_600_000) return;
    const h = state.hourly || { entries: 0, exits: 0, pnl: 0 }, open = Object.values(state.positions);
    const lines = [`🕐 **Stundenbericht** · ${this.botLabel ? this.botLabel + " · " : ""}${now.toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })}`,
      `Eigenkapital ${equity.toFixed(2)} USD · Positionen ${open.length}/${this.cfg.risk.maxOpenPositions}${this.risk.halted ? " · ⛔ Tageslimit erreicht" : ""}`,
      `Seit dem letzten Bericht: ${h.entries} Kauf/Käufe, ${h.exits} Verkauf/Verkäufe${h.exits ? `, Ergebnis ${h.pnl >= 0 ? "+" : ""}${h.pnl.toFixed(2)} USD netto` : ""}`, ""];
    for (const p of open) {
      const px = this.lastPrices[p.symbol] ?? p.entryPrice, pnl = (px - p.entryPrice) * p.amount;
      lines.push(`${pnl >= 0 ? "🟢" : "🔴"} **${p.symbol}** ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USD (${pctOf(px, p.entryPrice)}) · ${strategyLabel(p.strategyName)} · geöffnet ${ago(p.openedAt)} · Stop ${fmtPx(p.stop)} · Ziel ${fmtPx(p.takeProfit)}`);
    }
    if (open.length) lines.push("");
    for (const sym of this.symbols) {
      if (state.positions[sym]) continue;
      const a = state.activity[sym];
      lines.push(`• ${sym}${a?.price != null ? " " + fmtPx(a.price) : ""}${a?.regime ? " · " + (REGIME_DE[a.regime] || a.regime) : ""}: kein Kauf – ${this.whyNot(sym)}`);
    }
    state.hourly = { entries: 0, exits: 0, pnl: 0 };
    state.lastHourly = now.toISOString();
    await (this.notify.report || this.notify)(lines.join("\n"));
  }

  // ---- Positionen ----
  async managePosition(sym, { closed, live, isNew }, now) {
    const pos = this.state.positions[sym];
    if (!pos) return;
    const price = last(live.close), tfMs = timeframeSeconds(this.cfg.timeframe) * 1000;
    // Tiefstkurse zählen erst ab der Kerze nach der letzten Stop-Änderung (sonst würde ein nachgezogener Stop von alten Tiefs „getroffen“)
    const entryCandle = Math.floor(Date.parse(pos.stopChangedAt || pos.openedAt) / tfMs) * tfMs;
    let low = price;
    for (let i = 0; i < live.t.length; i++) if (live.t[i] > entryCandle) low = Math.min(low, live.low[i]);

    pos.hi = Math.max(pos.hi ?? pos.entryPrice, price, last(live.high)); pos.lo = Math.min(pos.lo ?? pos.entryPrice, price, last(live.low));   // bester/schlechtester Kurs seit Einstieg (für die Verlust-Analyse)
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
    // Ausstiegssignale erst nach einer Mindest-Haltedauer: sonst wird direkt nach dem Kauf wieder verkauft und nur die Kosten bleiben übrig (Stop/Ziel/Trailing gelten immer)
    const heldBars = (now.getTime() - Date.parse(pos.openedAt)) / tfMs;
    if (isNew && pos.strategySpec && heldBars >= (this.cfg.risk.minHoldBars ?? 0) && buildStrategy(pos.strategySpec).exit(closed).at(-1)) {
      return this.close(pos, price, `Ausstiegssignal der Strategie ${pos.strategyName}`, now);
    }
  }

  // ---- Stop/Ziel nachziehen (KI-Trailing) und manuelle Eingriffe ----
  recordAdjust(pos, kind, from, to, why, now, by) {
    (pos.history ||= []).push({ ts: now.toISOString(), kind, from, to, by, why });
    pos.history = pos.history.slice(-30);
    if (kind === "stop") pos.stopChangedAt = now.toISOString();
  }

  async manageTrail(sym, { closed, live }, now) {
    const pos = this.state.positions[sym];
    if (!pos || !this.cfg.trail?.enabled || pos.trailOff) return;
    const price = last(live.close), atrValue = last(atr(closed, this.cfg.risk.atrPeriod));
    let market = null;
    try { market = classifyMarket(closed); } catch { /* ohne Marktphase: vorsichtig sichern */ }
    const costFrac = (2 * (this.cfg.costs.feePct + this.cfg.costs.slippagePct)) / 100;
    const plan = planTrail(pos, price, atrValue, market, this.cfg.trail, costFrac);
    if (!plan) return;
    const parts = [];
    if (plan.stop != null) {
      const old = pos.stop; pos.stop = plan.stop;
      this.recordAdjust(pos, "stop", old, plan.stop, plan.why.join("; "), now, "KI");
      parts.push(`Stop-Loss ${fmtPx(old)} → ${fmtPx(plan.stop)} (sichert ${plan.lockedUsd >= 0 ? "+" : ""}${plan.lockedUsd.toFixed(2)} USD vor Gebühren)`);
      await this.logTrade({ ts: now.toISOString(), mode: this.broker.mode, symbol: sym, action: "STOP", price: plan.stop, amount: pos.amount, fee: 0, pnl: null, strategy: pos.strategyName, regime: pos.regime, reason: `KI-Trailing: ${plan.why.join("; ")}`, equity: await this.equity() });
    }
    if (plan.takeProfit != null) {
      const old = pos.takeProfit; pos.takeProfit = plan.takeProfit; pos.tpExtensions = (pos.tpExtensions || 0) + 1;
      this.recordAdjust(pos, "tp", old, plan.takeProfit, plan.why.join("; "), now, "KI");
      parts.push(`Take-Profit ${fmtPx(old)} → ${fmtPx(plan.takeProfit)}`);
    }
    await this.save();
    await this.notify(`TRAIL ${sym}: ${parts.join(" | ")} | aktueller Gewinn ${plan.profit >= 0 ? "+" : ""}${plan.profit.toFixed(2)} USD, Kurs ${fmtPx(price)}\nWarum: ${plan.why.join("; ")}`);
  }

  async freshPrice(sym) {
    const live = await this.fetchRecent(sym), price = last(live.close);
    this.lastPrices[sym] = price;
    this.broker.hintPrices?.(this.lastPrices);
    return { live, price, closed: sliceFrame(live, 0, live.t.length - 1) };
  }

  // Manuell: Stop-Loss/Take-Profit einer offenen Position setzen (nach oben ODER unten – eigene Entscheidung) und/oder das KI-Trailing für sie ein-/ausschalten.
  async adjustPosition(sym, { stop, takeProfit, trailOff } = {}, now = new Date()) {
    const pos = this.state.positions[sym];
    if (!pos) throw new Error(`${sym}: keine offene Position.`);
    const { price } = await this.freshPrice(sym), parts = [];
    if (stop != null) {
      if (!(stop > 0 && stop < price)) throw new Error(`Stop-Loss muss unter dem aktuellen Kurs (${fmtPx(price)}) liegen – zum sofortigen Beenden „Verkaufen“ nutzen.`);
      if (stop !== pos.stop) { const old = pos.stop; pos.stop = stop; this.recordAdjust(pos, "stop", old, stop, "manuell", now, "Du"); parts.push(`Stop-Loss ${fmtPx(old)} → ${fmtPx(stop)}`); }
    }
    if (takeProfit != null) {
      if (!(takeProfit > price)) throw new Error(`Take-Profit muss über dem aktuellen Kurs (${fmtPx(price)}) liegen.`);
      if (takeProfit !== pos.takeProfit) { const old = pos.takeProfit; pos.takeProfit = takeProfit; this.recordAdjust(pos, "tp", old, takeProfit, "manuell", now, "Du"); parts.push(`Take-Profit ${fmtPx(old)} → ${fmtPx(takeProfit)}`); }
    }
    if (trailOff != null && !!trailOff !== !!pos.trailOff) { pos.trailOff = !!trailOff; parts.push(`KI-Trailing ${pos.trailOff ? "AUS" : "AN"}`); }
    if (!parts.length) return "Nichts geändert.";
    await this.save();
    const text = `${sym} manuell angepasst: ${parts.join(" | ")}`;
    await this.notify(`STOP/ZIEL ${text}`);
    return text;
  }

  async manualSell(sym, now = new Date()) {
    const pos = this.state.positions[sym];
    if (!pos) throw new Error(`${sym}: keine offene Position.`);
    if (this.state.pending) throw new Error("Unklarer Orderstatus – erst zurücksetzen.");
    const { price } = await this.freshPrice(sym);
    await this.close(pos, price, "Manueller Verkauf (Dashboard)", now);
    return `${sym} verkauft`;
  }

  // Manueller Kauf (nur Paper): usd = Betrag (sonst Größe nach Risikoregel), stop/takeProfit optional (sonst ATR-Regeln wie beim Bot). Die harten Grenzen gelten auch hier.
  async manualBuy(sym, { usd, stop, takeProfit } = {}, now = new Date()) {
    if (this.broker.mode === "live") throw new Error("Manueller Kauf ist nur im Paper-Modus erlaubt.");
    if (this.state.pending) throw new Error("Unklarer Orderstatus – erst zurücksetzen.");
    if (!this.symbols.includes(sym)) throw new Error(`${sym}: gehört nicht zu diesem Bot.`);
    if (this.state.positions[sym]) throw new Error(`${sym}: Position ist schon offen.`);
    const [ok, why] = this.risk.canOpen(Object.keys(this.state.positions).length);
    if (!ok) throw new Error(`Kein Kauf möglich: ${why}`);
    const { price, closed } = await this.freshPrice(sym);
    if (closed.t.length < 30) throw new Error(`${sym}: zu wenige Kursdaten.`);
    const atrValue = last(atr(closed, this.cfg.risk.atrPeriod)), r = this.cfg.risk;
    const st = stop ?? price - atrValue * r.atrStopMult, tp = takeProfit ?? price + (price - st) * r.takeProfitRr;
    if (!(st > 0 && st < price)) throw new Error(`Stop-Loss muss unter dem Kurs (${fmtPx(price)}) liegen.`);
    if (!(tp > price)) throw new Error(`Take-Profit muss über dem Kurs (${fmtPx(price)}) liegen.`);
    const equity = await this.equity(), cash = await this.broker.cash();
    const costMul = (1 + this.cfg.costs.slippagePct / 100) * (1 + this.cfg.costs.feePct / 100);
    const amount = floorTo(usd != null ? Math.min(usd / price, cash / (price * costMul)) : positionSize(this.risk.sizingEquity(equity), cash, price, st, r, this.cfg.costs), price > 1000 ? 6 : 5);
    if (amount * price < MIN_NOTIONAL_USD) throw new Error(`Betrag zu klein (unter ${MIN_NOTIONAL_USD} USD oder Guthaben reicht nicht).`);
    if (amount * price > equity * (r.maxPositionPct / 100) * 1.0001) throw new Error(`Betrag ${(amount * price).toFixed(2)} USD übersteigt die maximale Positionsgröße (${r.maxPositionPct} % des Kapitals = ${(equity * r.maxPositionPct / 100).toFixed(2)} USD).`);
    const riskCash = amount * (price - st), riskPct = (riskCash / equity) * 100;
    if (riskPct > 2.0001) throw new Error(`Risiko ${riskPct.toFixed(2)} % des Kapitals liegt über der harten Grenze von 2 % – Stop näher setzen oder Betrag verkleinern.`);
    let market = null;
    try { market = classifyMarket(closed); } catch { /* egal */ }
    this.state.pending = { what: `Kauf ${sym}`, ts: now.toISOString() };
    await this.save();
    let fill;
    try { fill = await this.broker.openLong(sym, amount, st, price); }
    catch (e) { this.state.pending = null; await this.save(); throw e; }
    this.state.pending = null;
    const reason = `MANUELLER KAUF (Dashboard, nur Paper). Stop ${fmtPx(st)}${stop == null ? " (ATR-Regel)" : ""}, Ziel ${fmtPx(tp)}${takeProfit == null ? " (Regel)" : ""}; Risiko ca. ${riskCash.toFixed(2)} USD (${riskPct.toFixed(2)} % des Kapitals); wird danach nur über Stop/Ziel, KI-Trailing oder manuell beendet.`;
    this.state.positions[sym] = { symbol: sym, amount: fill.amount, entryPrice: fill.price, stop: st, initialStop: st, takeProfit: tp, entryFee: fill.fee,
      openedAt: now.toISOString(), strategySpec: null, strategyName: "Manuell", regime: market?.regime ?? "–", reason, manual: true };
    this.lastPrices[sym] = price;
    await this.save();
    await this.logTrade({ ts: now.toISOString(), mode: this.broker.mode, symbol: sym, action: "ENTRY", price: fill.price, amount: fill.amount, fee: fill.fee, pnl: null,
      strategy: "Manuell", regime: market?.regime ?? "–", reason, equity: await this.equity() });
    const h = (this.state.hourly ||= { entries: 0, exits: 0, pnl: 0 });
    h.entries++;
    await this.notify(`ENTRY ${sym} · Manuell\nKauf @ ${fmtPx(fill.price)} · Menge ${fill.amount.toFixed(5)} · Wert ${(fill.amount * fill.price).toFixed(2)} USD · Gebühr ${fill.fee.toFixed(2)} USD\n` +
      `Stop-Loss ${fmtPx(st)} (${pctOf(st, fill.price)}) · Take-Profit ${fmtPx(tp)} (${pctOf(tp, fill.price)}) · Risiko ${riskCash.toFixed(2)} USD\nWarum gekauft: manuell im Dashboard ausgelöst`);
    return `${sym} gekauft`;
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
    const analysis = this.explainExit(pos, fill, reason, now, pnl);
    delete this.state.positions[pos.symbol];
    this.exitedThisTick.add(pos.symbol); // kein Wiedereinstieg im selben Durchlauf
    await this.save();
    await this.logTrade({ ts: now.toISOString(), mode: this.broker.mode, symbol: pos.symbol, action: "EXIT", price: fill.price,
      amount: fill.amount, fee: fill.fee, pnl, strategy: pos.strategyName, regime: pos.regime, reason, equity: await this.equity(),
      analysis, entryTs: pos.openedAt, entryPrice: pos.entryPrice, initStop: pos.initialStop, initTp: (pos.history || []).find((e) => e.kind === "tp")?.from ?? pos.takeProfit, stop: pos.stop, takeProfit: pos.takeProfit,
      adj: (pos.history || []).map((e) => ({ ts: e.ts, kind: e.kind, from: e.from, to: e.to, by: e.by })) });
    const h = (this.state.hourly ||= { entries: 0, exits: 0, pnl: 0 });
    h.exits++; h.pnl += pnl;
    await this.trackStreak(pnl, now);
    await this.trackStrategy(pos, pnl, now);
    const cd = this.cfg.safety?.symbolCooldownHours;
    if (cd > 0 && pnl < 0 && !pos.manual && /Stop-Loss|Tagesverlust/.test(reason)) (this.state.symCool ||= {})[pos.symbol] = { until: new Date(now.getTime() + cd * 3.6e6).toISOString() };
    const held = (Date.parse(now.toISOString()) - Date.parse(pos.openedAt)) / 3.6e6, costs = pos.entryFee + fill.fee;
    await this.notify(`EXIT ${pos.symbol} · ${strategyLabel(pos.strategyName)}\n` +
      `Verkauf @ ${fmtPx(fill.price)} (Einstieg ${fmtPx(pos.entryPrice)}, ${pctOf(fill.price, pos.entryPrice)}) · Ergebnis ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USD netto (Gebühren ${costs.toFixed(2)} USD) · gehalten ${held < 48 ? held.toFixed(1) + " h" : (held / 24).toFixed(1) + " Tage"}\n` +
      `Stop war ${fmtPx(pos.stop)}, Ziel ${fmtPx(pos.takeProfit)}\nWarum verkauft: ${reason}\n${analysis}`);
  }

  // Warum ist dieser Trade so ausgegangen? Kurze, nachvollziehbare Analyse für Log, Dashboard und Discord
  explainExit(pos, fill, reason, now, pnl) {
    const tfMs = timeframeSeconds(this.cfg.timeframe) * 1000, held = now.getTime() - Date.parse(pos.openedAt), p = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(2)} %`;
    const move = (fill.price / pos.entryPrice - 1) * 100, gross = (fill.price - pos.entryPrice) * fill.amount, fees = pos.entryFee + fill.fee;
    const mfe = ((pos.hi ?? pos.entryPrice) / pos.entryPrice - 1) * 100, mae = ((pos.lo ?? pos.entryPrice) / pos.entryPrice - 1) * 100, stopDist = ((pos.entryPrice - (pos.initialStop ?? pos.stop)) / pos.entryPrice) * 100;
    const lines = [`Analyse: Kurs ${p(move)} (${fmtPx(pos.entryPrice)} → ${fmtPx(fill.price)}) · brutto ${gross >= 0 ? "+" : ""}${gross.toFixed(2)} USD, Gebühren −${fees.toFixed(2)} USD → netto ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USD · zwischendurch bestenfalls ${p(mfe)}, schlechtestenfalls ${p(mae)}`];
    const causes = [];
    if (pnl < 0) {
      if (/Tagesverlust/.test(reason)) causes.push("Notausstieg wegen Tagesverlust-Limit (alle Bots zusammen)");
      if (/Stop-Loss/.test(reason)) {
        const gap = ((pos.stop - fill.price) / pos.stop) * 100;
        if (gap > 0.15) causes.push(`Ausführung ${gap.toFixed(2)} % unter dem Stop (Kurslücke/Rutschen) – Verlust größer als geplant`);
        if (held < 3 * tfMs) causes.push(`Stop schon nach ${Math.max(1, Math.round(held / 60000))} Min ausgelöst; er war nur ${stopDist.toFixed(2)} % entfernt (Marktrauschen)`);
      }
      if (mfe < 0.3) causes.push("Kurs war nie nennenswert im Plus – der Einstieg lief direkt gegen den Markt (fallender Kurs)");
      else if (mfe >= 1) causes.push(`Kurs war zeitweise ${p(mfe)} im Plus, der Gewinn wurde nicht gesichert (Trailing startet erst ab ${this.cfg.trail?.startPct ?? 5} %)`);
      const br = this.state.breadth;
      if (br && br.n >= 3 && br.weak / br.n >= 0.5) causes.push(`Gesamtmarkt schwach: ${br.weak} von ${br.n} Märkten unter ihrer EMA50`);
      if (gross > 0) causes.push("Brutto im Plus, aber die Gebühren haben den Gewinn aufgefressen");
    }
    if (causes.length) lines.push(`Ursache: ${causes.join(" · ")}`);
    return lines.join("\n");
  }

  // Verlustserie: nach maxLossStreak Verlusten in Folge keine neuen Käufe dieses Bots für pauseHours (Abkühlphase); ein Gewinn setzt die Serie zurück
  async trackStreak(pnl, now) {
    const sf = this.cfg.safety, st = this.state;
    st.lossStreak = pnl > 0 ? 0 : (st.lossStreak || 0) + 1;
    if (sf?.maxLossStreak > 0 && st.lossStreak >= sf.maxLossStreak) {
      st.pauseUntil = new Date(now.getTime() + sf.pauseHours * 3.6e6).toISOString();
      st.lossStreak = 0;
      await this.notify(`WARNUNG: ${sf.maxLossStreak} Verluste in Folge – dieser Bot kauft nicht mehr bis ${new Date(st.pauseUntil).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })} (Abkühlphase ${sf.pauseHours} h). Bestehende Positionen laufen weiter.`);
    }
  }

  // Strategie-Sperre: Verliert dieselbe Strategie auf demselben Markt stratMaxLosses-mal hintereinander, wird genau diese Kombination stratPauseHours gesperrt (Backtests sagen oft mehr, als live hält)
  async trackStrategy(pos, pnl, now) {
    const sf = this.cfg.safety;
    if (!(sf?.stratMaxLosses > 0) || pos.manual || !pos.strategySpec) return;
    const key = `${pos.symbol}|${pos.strategyName}`, m = (this.state.stratLoss ||= {}), e = (m[key] ||= { n: 0 });
    e.n = pnl > 0 ? 0 : e.n + 1;
    if (e.n >= sf.stratMaxLosses) { e.until = new Date(now.getTime() + sf.stratPauseHours * 3.6e6).toISOString(); e.n = 0;
      await this.notify(`SPERRE ${pos.symbol} · ${strategyLabel(pos.strategyName)}: ${sf.stratMaxLosses} Verluste in Folge – diese Strategie kauft auf diesem Markt ${sf.stratPauseHours} h lang nicht mehr. Die anderen laufen weiter.`); }
    await this.save();
  }
  stratLocked(sym, name, now) { const u = this.state.stratLoss?.[`${sym}|${name}`]?.until; return !!u && now.getTime() < Date.parse(u); }

  isPaused(now) { return !!this.state.pauseUntil && now.getTime() < Date.parse(this.state.pauseUntil); }

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

  // Wann kommt voraussichtlich die nächste geschlossene Kerze? Nach dem tatsächlichen Takt (Ankunft der letzten Kerze + Kerzenlänge), nie später als eine Kerzenlänge ab jetzt
  nextCheck(sym, stamp, tfMs, now) {
    const seen = this.state.seenAt?.[sym], byGrid = stamp + 2 * tfMs;
    let next = seen ? Date.parse(seen) + tfMs : byGrid;
    while (next <= now.getTime()) next += tfMs;   // Kerze überfällig (Datenverzug): nächste Kerzengrenze danach
    return Math.min(next, now.getTime() + tfMs);
  }

  // ---- Sichtbarkeit: was der Bot gerade sieht und entscheidet (für die Anzeige im Popup) ----
  observe(sym, { closed, live, isNew, stamp }, now, tfMs) {
    let market = null, sel = null, signal = null, note = "", checks = [];
    try {
      market = classifyMarket(closed);
      sel = selectStrategy(this.state.approved || [], sym, this.cfg.timeframe, market);
      signal = sel ? !!sel.strategy.entry(closed).at(-1) : null;
      // Alle aktiven Strategien dieses Marktes prüfen (nicht nur die passendste): zeigt die ganze Signal-Matrix im Dashboard
      for (const rec of this.state.approved || []) {
        if (rec.symbol !== sym || rec.timeframe !== this.cfg.timeframe || rec.active === false) continue;
        try {
          const st = buildStrategy(rec.spec);
          checks.push({ name: rec.title || st.name, fits: st.regimes.includes(market.regime), signal: !!st.entry(closed).at(-1), sharpe: rec.metrics?.sharpe ?? null });
        } catch { /* ungültige Spezifikation überspringen */ }
      }
    } catch (e) { note = e.message; }
    this.state.activity[sym] = {
      ts: now.toISOString(), price: last(live.close), regime: market?.regime ?? null, volatility: market?.volatility ?? null,
      adx: market?.adx ?? null, strategy: sel?.strategy.name ?? null, signal, nextCandleAt: this.nextCheck(sym, stamp, tfMs, now), note, checks,
    };
    if (isNew) {
      const what = !market ? `Analyse nicht möglich (${note})`
        : !sel ? `${REGIME_DE[market.regime] || market.regime}: keine zugelassene Strategie für diese Marktphase → warte`
        : `${REGIME_DE[market.regime] || market.regime}: ${strategyLabel(sel.strategy.name)} → Signal ${signal ? "JA" : "nein"}`;
      const log = this.state.decisions ||= [];
      this.log("info", `${sym} · Kerze ${new Date(stamp).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })} · ${what}${this.state.positions[sym] ? " · Position offen" : ""}${this.risk.halted ? " · Tageslimit aktiv" : ""}`);
      log.push({ ts: now.toISOString(), symbol: sym, text: `${sym} · Kerze geprüft · ${what} · Kurs ${fmtPx(last(live.close))}${market ? ` · ADX ${market.adx != null ? market.adx.toFixed(0) : "–"}` : ""}${this.state.positions[sym] ? " · Position offen" : ""}${this.risk.halted ? " · Tageslimit aktiv" : ""}` });
      this.state.decisions = log.slice(-150);
    }
    return { market, sel, signal };
  }

  // Ein Signal wurde NICHT gekauft: Grund merken (Anzeige „Warum nicht?“) und im Entscheidungs-Log festhalten
  skip(sym, text, now) {
    (this.state.entryBlocked ||= {})[sym] = { ts: now.toISOString(), text };
    this.log("info", `${sym}: Signal, aber kein Kauf: ${text}`);
    (this.state.decisions ||= []).push({ ts: now.toISOString(), symbol: sym, text: `${sym} · Signal JA, aber KEIN KAUF: ${text}` });
  }

  // ---- Einstiege ----
  async lookForEntry(sym, { closed, live, isNew }, now, obs) {
    if (this.state.positions[sym] || this.exitedThisTick.has(sym) || !isNew) return;
    if (this.isPaused(now)) { this.log("info", `${sym}: Kaufpause nach Verlustserie bis ${new Date(this.state.pauseUntil).toLocaleTimeString("de-DE")} – kein Einstieg`); return; }
    const [ok, why] = this.risk.canOpen(Object.keys(this.state.positions).length);
    if (!ok) { console.info("Kein Einstieg:", why); this.log("info", `${sym}: Signal geprüft, aber kein Einstieg: ${why}`); return; }
    const { market, sel, signal } = obs;
    if (!market || !sel || !signal) return;
    const { strategy } = sel;
    if (this.stratLocked(sym, strategy.name, now)) return this.skip(sym, `${strategyLabel(strategy.name)} gesperrt (Verlustserie)`, now);
    const cool = this.state.symCool?.[sym];
    if (cool && now.getTime() < Date.parse(cool.until)) return this.skip(sym, `Abkühlung nach Stop-Loss bis ${new Date(cool.until).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`, now);
    const br = this.state.breadth, share = this.cfg.risk.weakMarketShare ?? 0;
    if (share > 0 && br && br.n >= 3 && br.weak / br.n >= share) return this.skip(sym, `Markt schwach: ${br.weak} von ${br.n} Märkten liegen unter ihrer EMA50 – keine neuen Käufe`, now);

    const price = last(live.close), atrValue = last(atr(closed, this.cfg.risk.atrPeriod));
    const risk = { ...this.cfg.risk, atrStopMult: strategy.stopMult(this.cfg.risk.atrStopMult), takeProfitRr: strategy.rr(this.cfg.risk.takeProfitRr) };
    const minStop = this.cfg.risk.minStopPct > 0 ? (price * this.cfg.risk.minStopPct) / 100 : 0, widened = minStop > atrValue * risk.atrStopMult;
    const [stop0, tp0] = stopAndTarget(price, widened ? minStop / risk.atrStopMult : atrValue, risk);
    if (stop0 <= 0) { console.warn(`${sym}: ATR unbrauchbar, kein Einstieg`); return; }
    // Stop und Ziel gelten ab dem ERWARTETEN Kaufpreis (Kurs + Rutschen), nicht ab dem Kurs ohne Rutschen – sonst kann ein Ziel unter dem echten Einstand liegen
    const entryPx = price * (1 + this.cfg.costs.slippagePct / 100), shift = entryPx - price, stop = stop0 + shift, takeProfit = tp0 + shift;
    // Kosten-Filter: Das Ziel muss deutlich mehr bringen, als Kauf + Verkauf kosten (Gebühr + Rutschen, beide Seiten) – sonst ist der Trade schon beim Einstieg verloren
    const roundTrip = price * 2 * (this.cfg.costs.feePct + this.cfg.costs.slippagePct) / 100, minMult = this.cfg.risk.minRewardToCost ?? 0;
    if (minMult > 0 && takeProfit - entryPx < minMult * roundTrip) {
      const text = `Ziel nur ${(((takeProfit - entryPx) / entryPx) * 100).toFixed(2)} % entfernt, Kosten für Kauf+Verkauf ${((roundTrip / price) * 100).toFixed(2)} % – verlangt wird mindestens das ${minMult}-fache`;
      return this.skip(sym, text, now);
    }
    const equity = await this.equity();
    const raw = positionSize(this.risk.sizingEquity(equity), await this.broker.cash(), entryPx, stop, this.cfg.risk, this.cfg.costs);
    const amount = floorTo(raw, price > 1000 ? 6 : 5);
    if (amount * price < MIN_NOTIONAL_USD) { console.info(`${sym}: Positionsgröße unter Minimum (${(amount * price).toFixed(2)} USD)`); this.log("info", `${sym}: Positionsgröße unter Minimum (${(amount * price).toFixed(2)} USD) – kein Kauf`); return; }

    const riskCash = amount * (entryPx - stop);
    const reason = `${sel.record.explore ? "EXPERIMENTELL (Strategie hat die strengen Prüfungen NICHT bestanden/wurde nicht geprüft): " : ""}${sel.record.title ? `${sel.record.title} – ` : ""}${strategy.explain(closed)}; Marktphase: ${summarize(market)}; Stop ${fmtPx(stop)} ` +
      `(${widened ? `Mindestabstand ${this.cfg.risk.minStopPct} %` : `${risk.atrStopMult}x ATR`}), Ziel ${fmtPx(takeProfit)}; Risiko ca. ${riskCash.toFixed(2)} ` +
      `(${((riskCash / equity) * 100).toFixed(2)}% des Kapitals); Backtest: Sharpe ${(sel.record.metrics?.sharpe ?? 0).toFixed(2)}, Trefferquote ${(sel.record.metrics?.win_rate_pct ?? 0).toFixed(1)}%`;

    this.state.pending = { what: `Kauf ${sym}`, ts: now.toISOString() };
    await this.save();
    let fill;
    try { fill = await this.broker.openLong(sym, amount, stop, price); }
    catch (e) { this.state.pending = null; await this.save(); await this.notify(`${sym}: Order fehlgeschlagen: ${e.message}`); return; }
    this.state.positions[sym] = {
      symbol: sym, amount: fill.amount, entryPrice: fill.price, stop, initialStop: stop, takeProfit, entryFee: fill.fee,
      openedAt: now.toISOString(), strategySpec: strategy.toSpec(), strategyName: strategy.name, regime: market.regime, reason,
    };
    this.state.pending = null;
    this.lastPrices[sym] = price;
    await this.save(); // Position sofort sichern
    await this.logTrade({ ts: now.toISOString(), mode: this.broker.mode, symbol: sym, action: "ENTRY", price: fill.price,
      amount: fill.amount, fee: fill.fee, pnl: null, strategy: strategy.name, regime: market.regime, reason, equity: await this.equity() });
    const h = (this.state.hourly ||= { entries: 0, exits: 0, pnl: 0 });
    h.entries++;
    const whyShort = `${sel.record.explore ? "experimentell (nicht auf Mindestwerte geprüft) · " : ""}Signal der Strategie „${strategyLabel(strategy.name)}“ bei Marktphase ${REGIME_DE[market.regime] || market.regime} · Backtest: Sharpe ${(sel.record.metrics?.sharpe ?? 0).toFixed(2)}, Trefferquote ${(sel.record.metrics?.win_rate_pct ?? 0).toFixed(0)} %`;
    await this.notify(`ENTRY ${sym} · ${strategyLabel(strategy.name)}\n` +
      `Kauf @ ${fmtPx(fill.price)} · Menge ${fill.amount.toFixed(5)} · Wert ${(fill.amount * fill.price).toFixed(2)} USD · Gebühr ${fill.fee.toFixed(2)} USD\n` +
      `Stop-Loss ${fmtPx(stop)} (${pctOf(stop, fill.price)}) · Take-Profit ${fmtPx(takeProfit)} (${pctOf(takeProfit, fill.price)}) · Risiko ${riskCash.toFixed(2)} USD\nWarum gekauft: ${whyShort}`);
  }

  // Testtrade (nur Paper): eröffnet sofort eine Position, ohne auf ein Strategie-Signal zu warten.
  // Stop/Ziel/Größe folgen den normalen Risikoregeln; die Position wird danach wie jede andere verwaltet.
  async testEntry(now = new Date()) {
    if (this.broker.mode === "live") throw new Error("Testtrade ist nur im Paper-Modus erlaubt.");
    if (this.state.pending) throw new Error("Unklarer Orderstatus – erst zurücksetzen.");
    const [ok, why] = this.risk.canOpen(Object.keys(this.state.positions).length);
    if (!ok) throw new Error(`Kein Einstieg möglich: ${why}`);
    const noData = new Set((this.state.problems || []).map((p) => p.split(":")[0]));
    let lastErr = "kein Markt verfügbar";
    for (const sym of this.symbols.filter((s) => !this.state.positions[s] && !noData.has(s))) {
      try {
        const live = await this.fetchRecent(sym), closed = sliceFrame(live, 0, live.t.length - 1);
        if (closed.t.length < 150) continue;
        this.lastPrices[sym] = last(live.close);
        this.broker.hintPrices?.(this.lastPrices);
        const market = classifyMarket(closed);
        const rec = (this.state.approved || []).filter((r) => r.symbol === sym && r.timeframe === this.cfg.timeframe && r.active !== false)
          .sort((a, b) => (b.metrics?.sharpe ?? -9) - (a.metrics?.sharpe ?? -9))[0];
        const strategy = buildStrategy(rec?.spec ?? { type: "breakout", params: { lookback: 55, exit_lookback: 20 } });
        const price = last(live.close), atrValue = last(atr(closed, this.cfg.risk.atrPeriod));
        const risk = { ...this.cfg.risk, atrStopMult: strategy.stopMult(this.cfg.risk.atrStopMult), takeProfitRr: strategy.rr(this.cfg.risk.takeProfitRr) };
        const [stop, takeProfit] = stopAndTarget(price, atrValue, risk);
        if (!(stop > 0)) continue;
        const equity = await this.equity();
        const amount = floorTo(positionSize(this.risk.sizingEquity(equity), await this.broker.cash(), price, stop, this.cfg.risk, this.cfg.costs), price > 1000 ? 6 : 5);
        if (amount * price < MIN_NOTIONAL_USD) continue;
        const fill = await this.broker.openLong(sym, amount, stop, price);
        const reason = `TESTTRADE (manuell ausgelöst, kein Strategie-Signal, nur Paper). Stop ${fmtPx(stop)}, Ziel ${fmtPx(takeProfit)}; ` +
          `Marktphase: ${summarize(market)}; wird danach nach den üblichen Regeln der Strategie ${strategy.name} verwaltet.`;
        this.state.positions[sym] = { symbol: sym, amount: fill.amount, entryPrice: fill.price, stop, initialStop: stop, takeProfit, entryFee: fill.fee,
          openedAt: now.toISOString(), strategySpec: strategy.toSpec(), strategyName: `Test · ${strategy.name}`, regime: market.regime, reason };
        await this.save();
        await this.logTrade({ ts: now.toISOString(), mode: this.broker.mode, symbol: sym, action: "ENTRY", price: fill.price, amount: fill.amount,
          fee: fill.fee, pnl: null, strategy: `Test · ${strategy.name}`, regime: market.regime, reason, equity: await this.equity() });
        await this.notify(`TESTTRADE ${sym} ${fill.amount.toFixed(5)} @ ${fmtPx(fill.price)} | Stop ${fmtPx(stop)} (Paper)`);
        return sym;
      } catch (e) { lastErr = `${sym}: ${e.message}`; }
    }
    throw new Error(`Testtrade nicht möglich (${lastErr}).`);
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
      this.state.problems = res.problems || [];
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
