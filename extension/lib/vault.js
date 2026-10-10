// Passwortgeschützter Tresor für den privaten Schlüssel der Bot-Wallet.
// AES-256-GCM, Schlüssel per PBKDF2-SHA256 (600.000 Iterationen) aus dem Passwort. Gespeichert wird nur Chiffretext;
// entsperrt liegt der Schlüssel in chrome.storage.session (nur im Speicher, weg beim Schließen des Browsers).
import { b64decode, b64encode } from "./util.js";
import { getLocal, setLocal, removeLocal, getSession, setSession, removeSession } from "./store.js";

const ITERATIONS = 600_000;
const subtle = () => globalThis.crypto.subtle;

async function deriveKey(password, salt, iterations = ITERATIONS) {
  const base = await subtle().importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, base,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function hasVault() { return !!(await getLocal("vault")); }
export async function vaultAddress() { return (await getLocal("vault"))?.address ?? null; }

// secretKey: Uint8Array(64), address: Base58-Adresse (öffentlich, zur Anzeige)
export async function createVault(password, secretKey, address, iterations = ITERATIONS) {
  if (!password || password.length < 8) throw new Error("Passwort muss mindestens 8 Zeichen haben.");
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, iterations);
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv }, key, secretKey));
  await setLocal("vault", { v: 1, iterations, salt: b64encode(salt), iv: b64encode(iv), ct: b64encode(ct), address });
  await setSession("unlocked", b64encode(secretKey));
}

export async function decryptVault(password) {
  const v = await getLocal("vault");
  if (!v) throw new Error("Keine Wallet vorhanden.");
  try {
    const key = await deriveKey(password, b64decode(v.salt), v.iterations);
    return new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: b64decode(v.iv) }, key, b64decode(v.ct)));
  } catch {
    throw new Error("Falsches Passwort.");
  }
}

export async function unlock(password) {
  const secret = await decryptVault(password);
  await setSession("unlocked", b64encode(secret));
  return secret;
}

export async function getUnlockedKey() {
  const b = await getSession("unlocked");
  return b ? b64decode(b) : null;
}

export const lock = () => removeSession("unlocked");

export async function deleteVault() {
  await removeLocal("vault");
  await removeSession("unlocked");
}
