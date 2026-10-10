import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, ASSETS } from "../lib/config.js";
import { SolanaWallet, SOL_MINT, generateKeypair } from "../lib/solana.js";

// Simulierte Welt: Salden je Token ändern sich bei jedem Swap; signAndSend wird durch eine Simulation ersetzt.
const BTC = ASSETS.BTC.mint, USDC = DEFAULTS.solana.usdcMint;
function world(prices = { sol: 100, btc: 60000 }) {
  const w = { sol: 1.0, bal: { [USDC]: 500, [BTC]: 0 }, prices, dec: { [BTC]: 8 }, swaps: [] };
  const json = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => "" });
  const priceOf = (mint) => (mint === SOL_MINT ? w.prices.sol : w.prices.btc);
  const decOf = (mint) => (mint === SOL_MINT ? 9 : w.dec[mint]);
  w.fetch = async (url, init) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/quote")) {
      const a = Number(u.searchParams.get("amount")), inM = u.searchParams.get("inputMint"), outM = u.searchParams.get("outputMint");
      const buy = inM === USDC, asset = buy ? outM : inM;
      const out = buy ? Math.floor((a / 1e6 / priceOf(asset)) * 10 ** decOf(asset)) : Math.floor((a / 10 ** decOf(asset)) * priceOf(asset) * 1e6);
      return json({ inAmount: String(a), outAmount: String(out), priceImpactPct: "0.0005", side: buy ? "buy" : "sell", asset });
    }
    const body = JSON.parse(init.body);
    if (u.pathname.endsWith("/swap")) return json({ swapTransaction: body.quoteResponse });
    const [m, p] = [body.method, body.params];
    if (m === "getBalance") return json({ result: { value: Math.round(w.sol * 1e9) } });
    if (m === "getTokenAccountsByOwner") return json({ result: { value: [{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: w.bal[p[1].mint] ?? 0 } } } } } }] } });
    if (m === "getTokenSupply") return json({ result: { value: { decimals: w.dec[p[0]] } } });
    if (m === "getSignatureStatuses") return json({ result: { value: [{ err: null, confirmationStatus: "confirmed" }] } });
    throw new Error(m);
  };
  return w;
}

function wallet(w) {
  const kp = generateKeypair(), cfg = structuredClone(DEFAULTS);
  const sw = new SolanaWallet(cfg, kp.secretKey, w.fetch);
  sw.signAndSend = async (q) => {
    const fee = (5000 + cfg.solana.priorityFeeLamports) / 1e9;
    const dec = q.asset === SOL_MINT ? 9 : w.dec[q.asset];
    if (q.side === "buy") {
      w.bal[USDC] -= q.inAmount / 1e6;
      if (q.asset === SOL_MINT) w.sol += q.outAmount / 1e9; else w.bal[q.asset] = (w.bal[q.asset] ?? 0) + q.outAmount / 10 ** dec;
    } else {
      w.bal[USDC] += q.outAmount / 1e6;
      if (q.asset === SOL_MINT) w.sol -= q.inAmount / 1e9; else w.bal[q.asset] -= q.inAmount / 10 ** dec;
    }
    w.sol -= fee;
    w.swaps.push(`${q.side}:${q.asset === SOL_MINT ? "SOL" : "BTC"}`);
    return "SIG";
  };
  Object.defineProperty(sw, "usdc", { get: () => w.bal[USDC] });
  return sw;
}
const close = (a, b, tol = 0.01) => Math.abs(a - b) / b < tol;

test("SOL-Kauf: Fill aus Wallet-Salden", async () => {
  const w = world(), sw = wallet(w);
  const fill = await sw.openLong("SOL/USD", 2.0, 95, 100);
  assert.ok(close(fill.amount, 2) && close(fill.price, 100));
  assert.ok(w.bal[USDC] < 500 && w.sol > 2.9);
});

test("SOL: Stop löst Verkauf aus und lässt die SOL-Reserve stehen", async () => {
  const w = world(), sw = wallet(w);
  await sw.openLong("SOL/USD", 2.0, 95, 100);
  const pos = { symbol: "SOL/USD", amount: 2.0, entryPrice: 100, stop: 95, takeProfit: 110, entryFee: 0.1 };
  assert.equal(await sw.checkStop(pos, 96, 97), null);
  w.prices.sol = 94;
  const fill = await sw.checkStop(pos, 94.5, 94);
  assert.ok(fill && close(fill.price, 94));
  assert.ok(w.sol >= sw.sc.solReserve);
  assert.deepEqual(w.swaps, ["buy:SOL", "sell:SOL"]);
});

test("BTC (8 Nachkommastellen, per RPC gelesen): Kauf, Stop-Verkauf, keine SOL-Reserve-Abzüge am Token", async () => {
  const w = world(), sw = wallet(w);
  const fill = await sw.openLong("BTC/USD", 0.002, 59000, 60000);
  assert.ok(close(fill.amount, 0.002, 0.02) && close(fill.price, 60000), `Fill ${fill.amount} @ ${fill.price}`);
  assert.ok(close(w.bal[BTC], fill.amount, 1e-6));
  const pos = { symbol: "BTC/USD", amount: fill.amount, entryPrice: fill.price, stop: 59000, takeProfit: 62000, entryFee: 0 };
  assert.equal(await sw.baseBalance("BTC/USD"), w.bal[BTC]);
  w.prices.btc = 58800;
  const out = await sw.checkStop(pos, 58900, 58800);
  assert.ok(out && close(out.price, 58800) && close(out.amount, fill.amount, 1e-6));
  assert.ok(w.bal[BTC] < 1e-8, "Token vollständig verkauft");
});

test("Schutz: falsche Token-Adresse bzw. Nachkommastellen -> Preisabgleich bricht ab, keine Transaktion", async () => {
  const w = world({ sol: 100, btc: 600 }), sw = wallet(w);          // Token kostet 600 statt 60000 (falscher Mint)
  await assert.rejects(sw.openLong("BTC/USD", 0.002, 59000, 60000), /weicht/);
  assert.deepEqual(w.swaps, []);
  const w2 = world(), sw2 = wallet(w2);
  w2.dec[BTC] = 6;                                                    // Chain meldet 6 statt 8 Stellen, Kurs unverändert
  sw2.decimalsCache[BTC] = 8;                                         // Wallet geht von 8 aus, Quote rechnet mit 6 -> 100x Abweichung
  await assert.rejects(sw2.openLong("BTC/USD", 0.002, 59000, 60000), /weicht/);
  assert.deepEqual(w2.swaps, []);
});

test("Preisabweichung > 1 % bricht ab (SOL)", async () => {
  const w = world({ sol: 130, btc: 60000 }), sw = wallet(w);
  await assert.rejects(sw.openLong("SOL/USD", 1.0, 95, 100), /weicht/);
  assert.deepEqual(w.swaps, []);
});

test("Eigene Token-Adresse aus den Einstellungen wird verwendet", () => {
  const cfg = structuredClone(DEFAULTS);
  cfg.solana.mints = { BTC: "CustomMint1111111111111111111111111111111111" };
  const sw = new SolanaWallet(cfg, null, async () => {}, "ADDR");
  assert.equal(sw.mintOf("BTC/USD"), "CustomMint1111111111111111111111111111111111");
  assert.equal(sw.mintOf("ETH/USD"), ASSETS.ETH.mint);
});

test("Gesperrte (lesende) Wallet kann nicht signieren", async () => {
  const w = world(), ro = new SolanaWallet(structuredClone(DEFAULTS), null, w.fetch, "ADDR");
  assert.ok(await ro.usdcBalance() > 0);
  await assert.rejects(ro.openLong("SOL/USD", 1, 95, 100), /gesperrt/);
});
