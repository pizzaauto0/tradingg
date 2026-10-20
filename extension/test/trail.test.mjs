// KI-Trailing (Stop/Ziel nachziehen) und manuelles Handeln im Dashboard (Kauf, Verkauf, Stop/Ziel ändern).
import test from "node:test";
import assert from "node:assert/strict";
import { installFakeChrome, makeCandles, marketFetch, TF_MS } from "./helpers.mjs";
import { handle, runTick, getStatus, whenIdle } from "../lib/controller.js";
import { planTrail } from "../lib/trail.js";

const T = { enabled: true, startUsd: 40, startR: 1.0, lockFraction: 0.75, extendTp: true };
const pos = (o = {}) => ({ entryPrice: 100, amount: 10, stop: 98, initialStop: 98, takeProfit: 105, ...o });   // 1R = 20 USD

test("Trailing: +40 Gewinn → Stop sichert +30 (75 %), nie unter dem alten Stop, nie ohne Gewinn", () => {
  const p = planTrail(pos(), 104, 1, null, T, 0);
  assert.ok(Math.abs(p.stop - 103) < 1e-9 && Math.abs(p.lockedUsd - 30) < 1e-9 && p.profit === 40);
  assert.equal(planTrail(pos({ stop: 103.2 }), 104, 1, null, T, 0), null, "Stop wird nie gelockert/gleich gesetzt");
  assert.equal(planTrail(pos(), 99, 1, null, T, 0), null, "im Minus: nichts");
  assert.equal(planTrail(pos(), 101, 1, null, T, 0), null, "Gewinn 10 < 40 und < 1R (20)");
  assert.ok(planTrail(pos(), 102.5, 1, null, T, 0), "ab 1R (25 ≥ 20) greift es auch unter 40 USD");
});

test("Trailing: Lage entscheidet – starker Trend lässt Spielraum, Seitwärts sichert mehr; Mindestabstand 0,5 ATR; Kosten-Boden", () => {
  const strong = planTrail(pos(), 104, 1, { regime: "uptrend", adx: 35 }, T, 0);
  const side = planTrail(pos(), 104, 1, { regime: "sideways", adx: 12 }, T, 0);
  assert.ok(Math.abs(strong.stop - 102.4) < 1e-9 && /Spielraum/.test(strong.why[0]));
  assert.ok(Math.abs(side.stop - 103.4) < 1e-9 && /mehr Gewinn sichern/.test(side.why[0]));
  assert.ok(strong.stop < side.stop);
  const wide = planTrail(pos(), 104, 3, null, T, 0);   // ATR 3 → höchstens Kurs − 1,5
  assert.ok(Math.abs(wide.stop - 102.5) < 1e-9 && wide.why.some((w) => /0,5 ATR/.test(w)));
  assert.equal(planTrail(pos(), 102.5, 1, null, T, 0.05), null, "Stop läge unter Einstand + Kosten → keine Bewegung");
});

test("Trailing: Ziel wird nur bei starkem Trend nahe am Ziel angehoben (höchstens 3 mal); Schalter wirken", () => {
  const near = planTrail(pos({ stop: 103.9 }), 104.5, 1, { regime: "uptrend", adx: 30 }, T, 0);
  assert.equal(near.takeProfit, 107);                                        // +1R-Abstand (2) auf das Ziel
  assert.equal(planTrail(pos({ stop: 104.4 }), 104.5, 1, { regime: "sideways", adx: 30 }, T, 0), null);
  assert.equal(planTrail(pos({ stop: 104.4, tpExtensions: 3 }), 104.5, 1, { regime: "uptrend", adx: 30 }, T, 0), null);
  assert.equal(planTrail(pos(), 104, 1, null, { ...T, enabled: false }, 0), null);
  assert.equal(planTrail(pos({ trailOff: true }), 104, 1, null, T, 0), null);
});

// ---- Integration über den Controller ----
const T0 = Math.floor(Date.now() / TF_MS) * TF_MS - 3 * TF_MS;
const at = (lastT, extra = 5000) => new Date(lastT + TF_MS + extra);
const permissive = { backtest: { minTrades: 0, minReturnPct: -1000, maxDrawdownPct: 100, minSharpe: -1000, minWinRatePct: 0, minProfitFactor: 0, minOosReturnPct: -1000 } };
const trend = (n, breakout = false) => makeCandles(n, T0, (i) => 100 + 0.12 * i + Math.sin(i / 3) * 0.1 + (breakout && i === n - 1 ? 3 : 0));
const shifted = (df, k = 1) => ({ ...df, t: df.t.map((t) => t + k * TF_MS) });

async function setup() {
  installFakeChrome();
  await handle({ type: "saveConfig", patch: { ...permissive, assets: ["SOL"], capital: { start: 1000 }, risk: { maxPositionPct: 50 } } });
  const world = { dfs: { "SOL/USD": trend(1500) } }, f = marketFetch(world);
  const key = "botState_paper", st = (await chrome.storage.local.get(key))[key] || {};
  st.approved = [{ symbol: "SOL/USD", timeframe: "15m", spec: { type: "breakout", params: { lookback: 10, exit_lookback: 5 }, regimes: ["uptrend"] }, name: "breakout(10,5)", metrics: { sharpe: 2, return_pct: 5 } }];
  st.lastRefresh = new Date().toISOString();
  await chrome.storage.local.set({ [key]: st });
  return { world, f };
}

test("Trailing im Betrieb: Stop wandert nach oben, alte Tiefs lösen ihn nicht aus, späterer Ausstieg liegt im Plus", async () => {
  const { world, f } = await setup();
  await handle({ type: "start" }, f); await whenIdle();
  await runTick({ fetchFn: f, now: at(world.dfs["SOL/USD"].t.at(-1)) });
  world.dfs["SOL/USD"] = shifted(trend(1501, true));
  await runTick({ fetchFn: f, now: at(world.dfs["SOL/USD"].t.at(-1)) });
  let p = (await getStatus()).state.positions["SOL/USD"];
  assert.ok(p, "gekauft"); const stop0 = p.stop, entry = p.entryPrice;
  await handle({ type: "adjust", symbol: "SOL/USD", takeProfit: entry * 1.3 }, f);   // Ziel weit weg, damit nur das Nachziehen getestet wird
  // Kurs steigt deutlich (neue Kerze, Tief bleibt über dem Stop)
  const up = shifted(trend(1502, true), 2), n = up.t.length - 1;
  up.open[n] = up.close[n - 1]; up.close[n] = entry + 8; up.high[n] = entry + 8.5; up.low[n] = entry + 6;
  world.dfs["SOL/USD"] = up;
  await runTick({ fetchFn: f, now: at(up.t.at(-1)) });
  p = (await getStatus()).state.positions["SOL/USD"];
  assert.ok(p.stop > stop0 && p.stop > entry, `Stop nachgezogen (${stop0} → ${p.stop})`);
  assert.equal(p.history.at(-1).by, "KI"); assert.ok(p.stopChangedAt);
  assert.ok((await getStatus()).trades.some((t) => t.action === "STOP"), "Nachziehen steht im Trade-Log");
  assert.ok((await getStatus()).events.some((e) => /^TRAIL /.test(e.text)), "Meldung TRAIL");
  const trailedStop = p.stop;
  // weitere Kerze ohne neues Tief unter dem Stop: Position bleibt (die Tiefs vor der Stop-Änderung zählen nicht)
  const up2 = shifted(up); const m = up2.t.length - 1;
  up2.open[m] = up.close.at(-1); up2.close[m] = entry + 8.2; up2.high[m] = entry + 8.6; up2.low[m] = entry + 7;
  world.dfs["SOL/USD"] = up2;
  await runTick({ fetchFn: f, now: at(up2.t.at(-1)) });
  assert.ok((await getStatus()).state.positions["SOL/USD"], "noch offen");
  // Kurs fällt unter den nachgezogenen Stop → Ausstieg im Plus
  const down = shifted(up2); const k = down.t.length - 1;
  down.open[k] = up2.close.at(-1); down.close[k] = trailedStop - 0.5; down.low[k] = trailedStop - 1; down.high[k] = down.open[k];
  world.dfs["SOL/USD"] = down;
  await runTick({ fetchFn: f, now: at(down.t.at(-1)) });
  const s = await getStatus();
  assert.equal(Object.keys(s.state.positions).length, 0);
  const exit = s.trades.find((t) => t.action === "EXIT");
  assert.ok(exit.pnl > 0, `Ausstieg im Plus: ${exit.pnl}`); assert.match(exit.reason, /Stop-Loss/);
});

test("Dashboard: manuell kaufen, Stop/Ziel/Trailing ändern, verkaufen – mit harten Grenzen", async () => {
  const { world, f } = await setup();
  const price = world.dfs["SOL/USD"].close.at(-1);
  await assert.rejects(handle({ type: "buy", symbol: "BTC/USD", usd: 100 }, f), /gehört nicht/);
  await assert.rejects(handle({ type: "buy", symbol: "SOL/USD", usd: 3 }, f), /zu klein/);
  await assert.rejects(handle({ type: "buy", symbol: "SOL/USD", usd: 900 }, f), /maximale Positionsgröße/);
  await assert.rejects(handle({ type: "buy", symbol: "SOL/USD", usd: 400, stop: price * 0.9 }, f), /Risiko .* 2 %/);   // 40 USD Risiko = 4 %
  await assert.rejects(handle({ type: "buy", symbol: "SOL/USD", usd: 100, stop: price * 1.1 }, f), /unter dem Kurs/);
  assert.equal(await handle({ type: "buy", symbol: "SOL/USD", usd: 200, stop: price * 0.99, takeProfit: price * 1.05 }, f), "SOL/USD gekauft");
  let s = await getStatus(); const p = s.state.positions["SOL/USD"];
  assert.ok(p.manual && p.strategyName === "Manuell" && Math.abs(p.stop - price * 0.99) < 1e-6 && p.initialStop === p.stop);
  assert.equal(s.trades[0].action, "ENTRY"); assert.match(s.trades[0].reason, /MANUELLER KAUF/);
  await assert.rejects(handle({ type: "buy", symbol: "SOL/USD", usd: 50 }, f), /schon offen/);
  // Stop/Ziel manuell verschieben
  await assert.rejects(handle({ type: "adjust", symbol: "SOL/USD", stop: price * 1.2 }, f), /unter dem aktuellen Kurs/);
  await assert.rejects(handle({ type: "adjust", symbol: "SOL/USD", takeProfit: price * 0.9 }, f), /über dem aktuellen Kurs/);
  await handle({ type: "adjust", symbol: "SOL/USD", stop: price * 0.995, takeProfit: price * 1.08, trailOff: true }, f);
  const q = (await getStatus()).state.positions["SOL/USD"];
  assert.ok(Math.abs(q.stop - price * 0.995) < 1e-6 && Math.abs(q.takeProfit - price * 1.08) < 1e-6 && q.trailOff === true);
  assert.deepEqual(q.history.map((h) => h.by), ["Du", "Du"]);
  assert.equal(await handle({ type: "adjust", symbol: "SOL/USD", stop: price * 0.995 }, f), "Nichts geändert.");
  // manuelle Position wird nicht vom Strategie-Ausstieg geschlossen (hat keine Strategie) und läuft im Tick ohne Fehler
  await handle({ type: "start" }, f); await whenIdle();
  await runTick({ fetchFn: f, now: at(world.dfs["SOL/USD"].t.at(-1)) });
  assert.ok((await getStatus()).state.positions["SOL/USD"]);
  assert.equal((await getStatus()).state.lastError, null);
  // verkaufen
  assert.equal(await handle({ type: "sell", symbol: "SOL/USD" }, f), "SOL/USD verkauft");
  s = await getStatus();
  assert.equal(Object.keys(s.state.positions).length, 0);
  assert.match(s.trades[0].reason, /Manueller Verkauf/); assert.equal(s.trades[0].action, "EXIT");
  await assert.rejects(handle({ type: "sell", symbol: "SOL/USD" }, f), /keine offene Position/);
});

test("Dashboard: Kauf nur im Paper-Modus (Live abgelehnt); Währungs-Bot kauft manuell mit dem gemeinsamen Konto", async () => {
  installFakeChrome();
  const world = { dfs: { "EUR/USD": makeCandles(400, T0, (i) => 1.08 + i * 0.00002 + Math.sin(i / 5) * 0.0004) } };
  const f = marketFetch(world);
  await handle({ type: "saveConfig", bot: "fx", patch: { assets: ["EURUSD"], timeframe: "15m", capital: { start: 1000 } } });
  const r = await handle({ type: "buy", bot: "fx", symbol: "EUR/USD", usd: 100 }, f);
  assert.equal(r, "EUR/USD gekauft");
  const acc = await handle({ type: "getAccount" });
  assert.ok(acc.cash < 900.5 && acc.bots.find((b) => b.id === "fx").positions === 1);
  assert.ok(Math.abs(acc.equity - 1000) < 5, "nur Kosten, kein Verlust durch gebundenes Geld");
  const c = await handle({ type: "chart", bot: "fx", symbol: "EUR/USD" }, f);
  assert.equal(c.manualBuy, true); assert.equal(c.trail.startUsd, 40); assert.ok(c.position.manual);
});
