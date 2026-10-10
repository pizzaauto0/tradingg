import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installFakeChrome } from "./helpers.mjs";
import { b58decode, b58encode } from "../lib/util.js";
import { parseSecretKey, signTransaction, generateKeypair } from "../lib/solana.js";
import { createVault, unlock, lock, getUnlockedKey, decryptVault, hasVault, deleteVault } from "../lib/vault.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/sign.json", import.meta.url)));

test("Base58 Rundreise und Schlüssel-Import (Phantom-Format, JSON-Array, Seed)", () => {
  const kp = parseSecretKey(fx.secret58);
  assert.equal(kp.address, fx.address);
  assert.equal(b58encode(b58decode(fx.secret58)), fx.secret58);
  assert.equal(parseSecretKey(JSON.stringify([...b58decode(fx.secret58)])).address, fx.address);
  assert.equal(parseSecretKey(b58encode(b58decode(fx.secret58).slice(0, 32))).address, fx.address);
  assert.throws(() => parseSecretKey("not a key"));
  assert.throws(() => parseSecretKey("abandon ability able about above absent absorb abstract absurd abuse access accident"));
});

test("Signierte Transaktion ist byte-identisch mit solders", () => {
  const { secretKey } = parseSecretKey(fx.secret58);
  assert.equal(signTransaction(fx.unsigned, secretKey), fx.expectedSigned);
});

test("Transaktion mit fremdem Gebührenzahler wird abgelehnt", () => {
  const { secretKey } = parseSecretKey(fx.secret58);
  assert.throws(() => signTransaction(fx.foreignUnsigned, secretKey), /andere Unterzeichner/);
});

test("Tresor: Verschlüsselung, falsches Passwort, Sperren/Entsperren", async () => {
  const c = installFakeChrome();
  const kp = generateKeypair();
  await createVault("geheim-123", kp.secretKey, kp.address, 1000);
  assert.ok(await hasVault());
  const stored = JSON.stringify(c.storage.local._m.get("vault"));
  assert.ok(!stored.includes(b58encode(kp.secretKey)), "Klartext darf nicht gespeichert sein");
  assert.deepEqual(await getUnlockedKey(), kp.secretKey);
  await lock();
  assert.equal(await getUnlockedKey(), null);
  await assert.rejects(unlock("falsch-1234"), /Falsches Passwort/);
  assert.deepEqual(await unlock("geheim-123"), kp.secretKey);
  assert.deepEqual(await decryptVault("geheim-123"), kp.secretKey);
  await assert.rejects(createVault("kurz", kp.secretKey, kp.address), /mindestens 8/);
  await deleteVault();
  assert.ok(!(await hasVault()));
});
