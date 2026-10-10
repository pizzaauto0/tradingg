// Solana-Wallet (SOL <-> USDC) über den Jupiter-Aggregator (Port von tradingbot/solana_broker.py).
// KEIN Stop bei einer Gegenseite: der Stop-Loss wird vom Bot überwacht und bei Auslösung per Swap verkauft.
import nacl from "./nacl.js";
import { b58decode, b58encode, b64decode, b64encode, sleep } from "./util.js";
import { ASSETS, baseOf } from "./config.js";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
const SOL_DECIMALS = 9, USDC_DECIMALS = 6, BASE_TX_FEE_LAMPORTS = 5000;

export class InsufficientFunds extends Error {}

// ---- Schlüssel -------------------------------------------------------------------------------------------------
export function generateKeypair() {
  const kp = nacl.sign.keyPair();
  return { secretKey: kp.secretKey, address: b58encode(kp.publicKey) };
}

// Akzeptiert Phantom-Export (Base58, 64 Byte), JSON-Array (Solana-CLI) oder 32-Byte-Seed.
export function parseSecretKey(input) {
  const s = String(input).trim();
  const bytes = s.startsWith("[") ? Uint8Array.from(JSON.parse(s)) : b58decode(s);
  const kp = bytes.length === 32 ? nacl.sign.keyPair.fromSeed(bytes) : bytes.length === 64 ? nacl.sign.keyPair.fromSecretKey(bytes) : null;
  if (!kp) throw new Error("Kein gültiger Solana-Schlüssel (erwartet 64 Byte, Base58) – nicht die Recovery-Phrase.");
  if (bytes.length === 64 && b58encode(bytes.slice(32)) !== b58encode(kp.publicKey)) throw new Error("Schlüssel ist inkonsistent.");
  return { secretKey: kp.secretKey, address: b58encode(kp.publicKey) };
}

// ---- Transaktion signieren ---------------------------------------------------------------------------------------
function readCompactU16(bytes, off) {
  let n = 0, shift = 0, b;
  do { b = bytes[off++]; n |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
  return [n, off];
}

// Signiert die von Jupiter gelieferte (unsignierte) Versioned Transaction. Bricht ab, wenn unsere Wallet nicht
// als einziger Unterzeichner und Gebührenzahler eingetragen ist.
export function signTransaction(b64tx, secretKey) {
  const raw = b64decode(b64tx);
  const [nSigs, sigStart] = readCompactU16(raw, 0);
  const msgStart = sigStart + 64 * nSigs, msg = raw.slice(msgStart);
  let off = msg[0] & 0x80 ? 1 : 0; // Versions-Präfix
  const required = msg[off];
  off += 3; // Header: Anzahl Unterzeichner, schreibgeschützte (signiert/unsigniert)
  const [, keysStart] = readCompactU16(msg, off);
  const payer = b58encode(msg.slice(keysStart, keysStart + 32));
  const ours = b58encode(secretKey.slice(32));
  if (nSigs !== 1 || required !== 1 || payer !== ours) throw new Error("Transaktion verlangt andere Unterzeichner – abgebrochen");
  raw.set(nacl.sign.detached(msg, secretKey), sigStart);
  return b64encode(raw);
}

// ---- Wallet / Broker -----------------------------------------------------------------------------------------------
export class SolanaWallet {
  mode = "live";
  // secretKey = null und address angegeben: nur lesender Zugriff (Salden anzeigen), Signieren nicht möglich.
  constructor(cfg, secretKey, fetchFn = fetch, address = null) {
    this.cfg = cfg; this.sc = cfg.solana; this.secretKey = secretKey; this.fetch = fetchFn;
    this.address = address ?? b58encode(secretKey.slice(32));
    this.decimalsCache = { [SOL_MINT]: SOL_DECIMALS, [cfg.solana.usdcMint]: USDC_DECIMALS };
    this.prices = {};
  }

  hintPrices(prices) { this.prices = prices; } // für die Gebührenumrechnung in USD

  mintOf(symbol) {
    const base = baseOf(symbol);
    return this.sc.mints?.[base] || ASSETS[base].mint;
  }

  async decimals(mint) { // Nachkommastellen werden von der Chain gelesen, nicht angenommen
    if (this.decimalsCache[mint] == null) this.decimalsCache[mint] = (await this.rpc("getTokenSupply", [mint])).value.decimals;
    return this.decimalsCache[mint];
  }

  async rpc(method, params) {
    const resp = await this.fetch(this.sc.rpcUrl, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (!resp.ok) throw new Error(`RPC HTTP ${resp.status}`);
    const body = await resp.json();
    if (body.error) throw new Error(`RPC ${method}: ${JSON.stringify(body.error)}`);
    return body.result;
  }

  async solBalance() { return (await this.rpc("getBalance", [this.address, { commitment: "confirmed" }])).value / 10 ** SOL_DECIMALS; }

  async tokenBalance(mint) {
    const res = await this.rpc("getTokenAccountsByOwner", [this.address, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]);
    return res.value.reduce((s, a) => s + (a.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
  }

  usdcBalance() { return this.tokenBalance(this.sc.usdcMint); }
  cash() { return this.usdcBalance(); }

  // Menge des Assets, die verkauft werden darf (bei SOL bleibt die Gebühren-Reserve stehen).
  async baseBalance(symbol) {
    const mint = this.mintOf(symbol);
    return mint === SOL_MINT ? Math.max((await this.solBalance()) - this.sc.solReserve, 0) : this.tokenBalance(mint);
  }

  async jupiter(path, init) {
    const resp = await this.fetch(`${this.sc.jupiterUrl}${path}`, init);
    if (!resp.ok) throw new Error(`Jupiter HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    return resp.json();
  }

  quote(inMint, outMint, amountRaw) {
    const q = new URLSearchParams({ inputMint: inMint, outputMint: outMint, amount: String(amountRaw),
      slippageBps: String(this.sc.slippageBps), restrictIntermediateTokens: "true" });
    return this.jupiter(`/quote?${q}`);
  }

  async swapTx(quote) {
    const body = await this.jupiter("/swap", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ quoteResponse: quote, userPublicKey: this.address, wrapAndUnwrapSol: true,
        prioritizationFeeLamports: this.sc.priorityFeeLamports }) });
    return body.swapTransaction;
  }

  signAndSend(b64tx) {
    if (!this.secretKey) throw new Error("Wallet ist gesperrt");
    const signed = signTransaction(b64tx, this.secretKey);
    return this.rpc("sendTransaction", [signed, { encoding: "base64", skipPreflight: false, maxRetries: 3 }]);
  }

  async confirm(signature, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const st = (await this.rpc("getSignatureStatuses", [[signature], { searchTransactionHistory: true }])).value[0];
      if (st) {
        if (st.err) throw new Error(`Transaktion ${signature} fehlgeschlagen: ${JSON.stringify(st.err)}`);
        if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") return;
      }
      await sleep(2000);
    }
    throw new Error(`Transaktion ${signature} nicht bestätigt (Status unklar – Wallet prüfen!)`);
  }

  // Schutz gegen falsche Token-Adressen, Fehlkurse und dünne Liquidität: Jupiter-Preis muss zum Börsenkurs passen.
  checkQuote(q, side, refPrice, assetDecimals) {
    const inAmt = Number(q.inAmount), outAmt = Number(q.outAmount);
    const price = side === "buy" ? (inAmt / 10 ** USDC_DECIMALS) / (outAmt / 10 ** assetDecimals)
      : (outAmt / 10 ** USDC_DECIMALS) / (inAmt / 10 ** assetDecimals);
    const dev = Math.abs(price / refPrice - 1) * 100;
    if (!(dev <= this.sc.maxDeviationPct)) throw new Error(`Jupiter-Preis ${price.toFixed(4)} weicht ${dev.toFixed(2)}% von Referenz ${refPrice.toFixed(4)} ab – abgebrochen`);
    const impact = Number(q.priceImpactPct || 0) * 100;
    if (impact > this.sc.maxPriceImpactPct) throw new Error(`Preisauswirkung ${impact.toFixed(2)}% zu hoch – abgebrochen`);
  }

  // Gibt { amount, price, fee } anhand der tatsächlichen Wallet-Salden zurück.
  async swap(side, symbol, amountRaw, refPrice) {
    const mint = this.mintOf(symbol), isSol = mint === SOL_MINT, dec = await this.decimals(mint);
    const [inMint, outMint] = side === "buy" ? [this.sc.usdcMint, mint] : [mint, this.sc.usdcMint];
    const q = await this.quote(inMint, outMint, amountRaw);
    this.checkQuote(q, side, refPrice, dec);
    const bal = async () => [await this.solBalance(), await this.tokenBalance(mint), await this.usdcBalance()];
    const [sol0, tok0, usdc0] = await bal();
    const signature = await this.signAndSend(await this.swapTx(q));
    await this.confirm(signature);
    const [sol1, tok1, usdc1] = await bal();
    const feeSol = (BASE_TX_FEE_LAMPORTS + this.sc.priorityFeeLamports) / 10 ** SOL_DECIMALS;
    // Menge des gehandelten Assets; bei SOL die Netzwerkgebühr herausrechnen (sie fällt im selben Konto an)
    const moved = isSol ? Math.abs(sol1 - sol0 + (side === "buy" ? feeSol : -feeSol)) : Math.abs(tok1 - tok0);
    const usdcMoved = Math.abs(usdc1 - usdc0);
    if (!(moved > 0 && usdcMoved > 0)) throw new Error(`Swap ${signature} bestätigt, aber keine Saldenänderung erkannt – Wallet prüfen!`);
    const solUsd = this.prices["SOL/USD"] ?? 150;
    return { amount: moved, price: usdcMoved / moved, fee: feeSol * solUsd, signature };
  }

  async openLong(symbol, amount, stop, refPrice) {
    const buffer = 1 + this.sc.slippageBps / 10_000 + 0.001;
    const usdc = await this.usdcBalance();
    const spend = Math.min(amount * refPrice * buffer, usdc);
    if (spend < 1) throw new InsufficientFunds(`USDC-Guthaben (${usdc.toFixed(2)}) zu gering`);
    if ((await this.solBalance()) < this.sc.solReserve) throw new InsufficientFunds(`SOL-Reserve für Gebühren unterschritten (< ${this.sc.solReserve})`);
    const r = await this.swap("buy", symbol, Math.floor(spend * 10 ** USDC_DECIMALS), refPrice);
    return { price: r.price, amount: r.amount, fee: r.fee, orderId: r.signature };
  }

  async closeLong(pos, refPrice) {
    const mint = this.mintOf(pos.symbol), dec = await this.decimals(mint);
    const sellable = Math.min(pos.amount, await this.baseBalance(pos.symbol));
    const raw = Math.floor(sellable * 10 ** dec);
    if (raw <= 0) throw new InsufficientFunds(`Keine verkaufbare Menge ${pos.symbol} in der Wallet`);
    const r = await this.swap("sell", pos.symbol, raw, refPrice);
    return { price: r.price, amount: r.amount, fee: r.fee, orderId: r.signature };
  }

  // Bot-seitiger Stop: Kurs hat den Stop erreicht -> sofort per Swap verkaufen.
  async checkStop(pos, lowSinceEntry, lastPrice) {
    if (lowSinceEntry > pos.stop) return null;
    return this.closeLong(pos, lastPrice);
  }
}

// ---- Paper-Broker (Simulation, keine echten Orders) -------------------------------------------------------------------
export class PaperBroker {
  mode = "paper";
  constructor(cfg, state) {
    this.fee = cfg.costs.feePct / 100; this.slip = cfg.costs.slippagePct / 100;
    this.s = state.paper = state.paper || { cash: cfg.capital.start };
  }
  async cash() { return this.s.cash; }
  async openLong(symbol, amount, stop, refPrice) {
    const px = refPrice * (1 + this.slip), fee = amount * px * this.fee, cost = amount * px + fee;
    if (cost > this.s.cash + 1e-9) throw new InsufficientFunds(`Paper-Guthaben ${this.s.cash.toFixed(2)} reicht nicht für ${cost.toFixed(2)}`);
    this.s.cash -= cost;
    return { price: px, amount, fee, orderId: `paper-${Math.random().toString(16).slice(2, 10)}` };
  }
  async closeLong(pos, refPrice) {
    const px = refPrice * (1 - this.slip), fee = pos.amount * px * this.fee;
    this.s.cash += pos.amount * px - fee;
    return { price: px, amount: pos.amount, fee, orderId: `paper-${Math.random().toString(16).slice(2, 10)}` };
  }
  async checkStop(pos, lowSinceEntry, lastPrice) {
    return lowSinceEntry > pos.stop ? null : this.closeLong(pos, Math.min(pos.stop, lastPrice));
  }
}
