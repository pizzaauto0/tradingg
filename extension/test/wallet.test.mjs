import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS } from "../lib/config.js";
import { SolanaWallet, SOL_MINT } from "../lib/solana.js";
import { generateKeypair } from "../lib/solana.js";

// Simulierte Welt: Wallet-Salden ändern sich bei jedem Swap; signTransaction wird durch Überschreiben umgangen.
function world(price = 100) {
  const w = { sol: 1.0, usdc: 500, price, swaps: [] };
  const json = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => "" });
  w.fetch = async (url, init) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/quote")) {
      const a = Number(u.searchParams.get("amount")), buy = u.searchParams.get("inputMint") !== SOL_MINT;
      return json(buy ? { inAmount: String(a), outAmount: String(Math.floor((a / 1e6 / w.price) * 1e9)), priceImpactPct: "0.0005", side: "buy" }
        : { inAmount: String(a), outAmount: String(Math.floor((a / 1e9) * w.price * 1e6)), priceImpactPct: "0.0005", side: "sell" });
    }
    const body = JSON.parse(init.body);
    if (u.pathname.endsWith("/swap")) return json({ swapTransaction: body.quoteResponse });
    const [m] = [body.method];
    if (m === "getBalance") return json({ result: { value: Math.round(w.sol * 1e9) } });
    if (m === "getTokenAccountsByOwner") return json({ result: { value: [{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: w.usdc } } } } } }] } });
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
    if (q.side === "buy") { w.usdc -= q.inAmount / 1e6; w.sol += q.outAmount / 1e9 - fee; } else { w.sol -= q.inAmount / 1e9 + fee; w.usdc += q.outAmount / 1e6; }
    w.swaps.push(q.side);
    return "SIG";
  };
  return sw;
}

test("Kauf: Fill aus Wallet-Salden", async () => {
  const w = world(), sw = wallet(w);
  const fill = await sw.openLong(2.0, 95, 100);
  assert.ok(Math.abs(fill.amount - 2) / 2 < 0.01 && Math.abs(fill.price - 100) / 100 < 0.01);
  assert.ok(w.usdc < 500 && w.sol > 2.9);
});

test("Stop löst Verkauf aus und lässt die SOL-Reserve stehen", async () => {
  const w = world(), sw = wallet(w);
  await sw.openLong(2.0, 95, 100);
  const pos = { symbol: "SOL/USD", amount: 2.0, entryPrice: 100, stop: 95, takeProfit: 110, entryFee: 0.1 };
  assert.equal(await sw.checkStop(pos, 96, 97), null);
  w.price = 94;
  const fill = await sw.checkStop(pos, 94.5, 94);
  assert.ok(fill && Math.abs(fill.price - 94) / 94 < 0.01);
  assert.ok(w.sol >= sw.sc.solReserve);
  assert.deepEqual(w.swaps, ["buy", "sell"]);
});

test("Schutz: Preisabweichung > 1 % bricht ab, keine Transaktion", async () => {
  const w = world(130), sw = wallet(w);
  await assert.rejects(sw.openLong(1.0, 95, 100), /weicht/);
  assert.deepEqual(w.swaps, []);
});

test("Gesperrte (lesende) Wallet kann nicht signieren", async () => {
  const w = world(), cfg = structuredClone(DEFAULTS);
  const ro = new SolanaWallet(cfg, null, w.fetch, "ADDR");
  assert.ok(await ro.usdcBalance() > 0);
  await assert.rejects(ro.openLong(1, 95, 100), /gesperrt/);
});
