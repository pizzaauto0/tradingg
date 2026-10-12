import test from "node:test";
import assert from "node:assert/strict";
import { installFakeChrome } from "./helpers.mjs";
import { handle, getStatus } from "../lib/controller.js";

const DAY = 86_400_000;
// Kraken-Antwort mit Tageskerzen (interval=1440): 720 Kerzen, letzte bereits geschlossen
function krakenDaily(url) {
  const u = new URL(url);
  assert.equal(u.searchParams.get("interval"), "1440");
  const end = Math.floor(Date.now() / DAY) * DAY - DAY, n = 720;
  const rows = Array.from({ length: n }, (_, i) => {
    const c = 100 + i * 0.08 + Math.sin(i / 5) * 3, o = c - Math.cos(i / 5) * 1.2;
    return [Math.floor((end - (n - 1 - i) * DAY) / 1000), o, Math.max(o, c) + 1, Math.min(o, c) - 1, c, c, 5, 3];
  });
  return { ok: true, status: 200, json: async () => ({ error: [], result: { X: rows, last: 1 } }) };
}

test("Final-3 auf Tageskerzen: Scan mit 720 Kerzen funktioniert, alle drei Strategien werden getestet, nur Paper", async () => {
  installFakeChrome();
  await handle({ type: "saveConfig", patch: { timeframe: "1d", assets: ["BTC", "SOL"], backtest: { profile: "final" } } });
  const f = async (url) => (String(url).includes("kraken") ? krakenDaily(String(url)) : { ok: false, status: 500, json: async () => ({}) });
  const r = await handle({ type: "research" }, f);
  assert.equal(r.markets, 2);
  assert.equal(r.problems.length, 0, r.problems.join("|"));
  const s = await getStatus();
  assert.equal(s.cfg.timeframe, "1d");
  assert.equal(new Set(s.state.report.map((x) => x.title)).size, 3);
  assert.ok(s.state.approved.length === 6 && s.state.approved.every((a) => a.active && a.timeframe === "1d"));
});
