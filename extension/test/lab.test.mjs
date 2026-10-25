// Labor: Varianten unterscheiden sich in GENAU einer Einstellung von der Basis, laufen mit eigenem Paper-Geld, Auswertung + Log-Dateien.
import test from "node:test";
import assert from "node:assert/strict";
import { installFakeChrome, makeCandles, marketFetch, TF_MS } from "./helpers.mjs";
import { handle, runTick, getLab, whenIdle } from "../lib/controller.js";
import { labVariants, labInsights, labLogText } from "../lib/lab.js";
import { botDefaults, DEFAULTS } from "../lib/config.js";

const T0 = Math.floor(Date.now() / TF_MS) * TF_MS - 3 * TF_MS;
const trend = (n) => makeCandles(n, T0, (i) => 100 + 0.12 * i + Math.sin(i / 3) * 0.1);
const flat = (o, p = "") => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" && !Array.isArray(v) ? flat(v, `${p}${k}.`) : [[`${p}${k}`, JSON.stringify(v)]]));

test("Varianten: jede weicht in genau EINER Einstellung von der Basis ab", () => {
  for (const [bot, cfg] of [["crypto", DEFAULTS], ["fx", botDefaults("fx")], ["metals", botDefaults("metals")]]) {
    const vs = labVariants(cfg, bot), base = Object.fromEntries(flat(vs[0].cfg));
    assert.equal(vs[0].id, "base"); assert.ok(vs.length > 35, `${bot}: ${vs.length} Varianten`);
    assert.equal(new Set(vs.map((v) => v.id)).size, vs.length, "eindeutige IDs");
    for (const v of vs.slice(1)) {
      const diff = flat(v.cfg).filter(([k, x]) => base[k] !== x);
      assert.equal(diff.length, 1, `${bot} ${v.id} ändert ${diff.map((d) => d[0]).join(", ")}`);
    }
    assert.equal(vs[0].cfg.backtest.profile, "playbook"); assert.equal(vs[0].cfg.liveTrading, false);
  }
  const tfs = labVariants(DEFAULTS, "crypto").filter((v) => v.group === "tf").map((v) => v.cfg.timeframe);
  assert.ok(!tfs.includes(DEFAULTS.timeframe) && tfs.length === 4, "alle anderen Zeitrahmen, nicht der der Basis");
});

test("Labor läuft: eigenes Paper-Geld je Variante, geteilte Strategie-Sets, Log-Dateien, Auswertung", async () => {
  await whenIdle(); installFakeChrome();
  await handle({ type: "saveConfig", patch: { assets: ["SOL"], capital: { start: 1000 }, compare: { enabled: true } } });
  const world = { dfs: { "SOL/USD": trend(1500) } }, f = marketFetch(world), logs = new Map();
  globalThis.desktopLog = async (p, t) => { logs.set(p, t); };
  try {
    let now = new Date(world.dfs["SOL/USD"].t.at(-1) + TF_MS + 5000);
    for (let i = 0; i < 9; i++) { await runTick({ fetchFn: f, now }); now = new Date(now.getTime() + 60_000); }
    const lab = await getLab(), c = lab.bots.find((b) => b.bot === "crypto");
    assert.ok(c.rows.length > 35 && c.rows[0].id === "base");
    assert.ok(c.rows.filter((r) => r.ready).length > 10, "Varianten haben Zustand");
    assert.ok(c.rows.every((r) => Math.abs(r.equity - 1000) < 1000), "eigenes Paper-Geld (Start 1000)");
    const store = await chrome.storage.local.get(null);
    assert.ok(store.lab_crypto && store.labShared_crypto, "gespeichert");
    assert.ok([...logs.keys()].some((k) => k.startsWith("lab/crypto/stunde_")), "Labor-Log je Bot");
    const text = labLogText({ botLabel: "Krypto", now: Date.now(), rows: c.rows, kind: "6h", since: 0, entries: store.lab_crypto.variants, variants: labVariants({ ...DEFAULTS, assets: ["SOL"] }, "crypto") });
    assert.match(text, /BASIS/); assert.match(text, /Zeitrahmen/); assert.match(text, /Δ Basis/);
    assert.ok(Array.isArray(labInsights(c.rows)));
    await handle({ type: "resetLab" }); assert.equal((await getLab()).bots[0].rows.filter((r) => r.ready).length, 0);
  } finally { delete globalThis.desktopLog; }
});
