import test from "node:test";
import assert from "node:assert/strict";
import { pairTrades, levelSteps, exitKind } from "../lib/history.js";

test("Bisherige Trades: Kauf+Verkauf, Stop-/Ziel-Verlauf, neueste zuerst", () => {
  const trades = [
    { ts: "2026-01-01T10:00:00Z", action: "ENTRY", symbol: "SOL/USD", price: 100, fee: 0.2 },
    { ts: "2026-01-01T12:00:00Z", action: "STOP", symbol: "SOL/USD", price: 102 },
    { ts: "2026-01-01T13:00:00Z", action: "EXIT", symbol: "SOL/USD", price: 105, amount: 1, fee: 0.2, pnl: 4.6, strategy: "range_support(1)", reason: "Stop-Loss bei 104 ausgelöst",
      entryTs: "2026-01-01T10:00:00Z", entryPrice: 100, initStop: 98, initTp: 110, stop: 104, takeProfit: 110,
      adj: [{ ts: "2026-01-01T12:00:00Z", kind: "stop", from: 98, to: 102, by: "KI" }, { ts: "2026-01-01T12:30:00Z", kind: "stop", from: 102, to: 104, by: "KI" }] },
    { ts: "2026-01-02T10:00:00Z", action: "ENTRY", symbol: "BTC/USD", price: 50000, fee: 1 },
    { ts: "2026-01-02T11:00:00Z", action: "EXIT", symbol: "BTC/USD", price: 49000, amount: 0.01, fee: 1, pnl: -12, reason: "Ausstiegssignal der Strategie x" },
  ];
  const r = pairTrades(trades);
  assert.equal(r.length, 2); assert.equal(r[0].symbol, "BTC/USD", "neueste zuerst");
  assert.equal(r[0].kind, "Signal"); assert.equal(r[0].entryPrice, 50000, "ohne Zusatzfelder: aus dem Kauf");
  assert.equal(r[1].kind, "Stop-Loss"); assert.equal(r[1].fees, 0.4);
  const st = levelSteps(r[1], "stop");
  assert.deepEqual(st.map((p) => p.price), [98, 102, 104]);
  assert.deepEqual(levelSteps(r[1], "tp").map((p) => p.price), [110]);
  assert.equal(exitKind("Take-Profit 5 erreicht"), "Ziel erreicht");
});
