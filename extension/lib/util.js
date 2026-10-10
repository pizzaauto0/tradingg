// Hilfsfunktionen: Base58/Base64, Zeitrahmen, Warten.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function b58encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  return "1".repeat(zeros) + out;
}

export function b58decode(str) {
  let n = 0n, zeros = 0;
  while (zeros < str.length && str[zeros] === "1") zeros++;
  for (const ch of str) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error("Ungültiges Base58-Zeichen");
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  return Uint8Array.from([...new Array(zeros).fill(0), ...bytes]);
}

export function b64encode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64decode(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const UNITS = { m: 60, h: 3600, d: 86400 };
export function timeframeSeconds(tf) {
  const m = /^(\d+)([mhd])$/.exec(tf);
  if (!m) throw new Error(`Ungültiger Zeitrahmen: ${tf}`);
  return Number(m[1]) * UNITS[m[2]];
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const nowIso = () => new Date().toISOString();
