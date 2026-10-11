// Steuerung per Telegram: der Bot fragt alle 30 s neue Nachrichten ab und führt NUR Befehle aus deinem eigenen Chat aus.
// Bewusst nur risikomindernde Befehle: Status ansehen, Handel stoppen, Positionen schließen. Kein „starten“, keine Einstellungen.
const api = (token, method) => `https://api.telegram.org/bot${token}/${method}`;
const MAX_AGE_S = 120; // ältere Nachrichten werden ignoriert (z. B. ein vergessener /kill von gestern)

export const HELP = [
  "Befehle:",
  "/status – Zustand, Positionen und Märkte",
  "/stop – Handel stoppen (offene Positionen bleiben)",
  "/kill ja – NOT-AUS: alle Positionen schließen und stoppen",
  "/help – diese Hilfe",
  "Starten und Einstellungen gehen nur im Browser.",
].join("\n");

const ago = (iso) => (iso ? `${Math.round((Date.now() - Date.parse(iso)) / 1000)} s` : "–");

export function formatStatus(s) {
  const live = s.cfg.liveTrading, pos = Object.values(s.state.positions);
  const lines = [
    `${live ? "LIVE" : "PAPER"} · ${s.state.killRequested ? "NOT-AUS aktiv" : s.state.enabled ? "läuft" : "gestoppt"} · letzte Prüfung vor ${ago(s.state.lastTick)}`,
    `Aktive Strategien: ${s.state.approved.filter((a) => a.active).length} (${s.state.approved.length} zugelassen)`,
  ];
  if (s.state.locked) lines.push("WARNUNG: Wallet gesperrt – im Browser entsperren!");
  if (s.state.pending) lines.push(`WARNUNG: Unklarer Orderstatus (${s.state.pending.what}) – Wallet prüfen!`);
  if (s.state.risk?.halted) lines.push("Tageslimit erreicht – kein neuer Handel bis morgen.");
  lines.push(pos.length ? "Positionen:" : "Keine offene Position.");
  for (const p of pos) {
    const px = s.state.activity[p.symbol]?.price, pnl = px ? p.side * (px - p.entryPrice) * p.amount : null;
    lines.push(`• ${p.symbol} ${p.amount.toFixed(4)} @ ${p.entryPrice.toFixed(4)} | Stop ${p.stop.toFixed(4)} | Ziel ${p.takeProfit.toFixed(4)}${pnl == null ? "" : ` | ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USD`} | ${p.strategyName}`);
  }
  const markets = Object.entries(s.state.activity).filter(([, a]) => a.price != null).slice(0, 12);
  if (markets.length) lines.push("Märkte: " + markets.map(([sym, a]) => `${sym.split("/")[0]} ${a.price < 10 ? a.price.toFixed(3) : a.price.toFixed(1)} ${a.regime ?? ""}${a.signal ? " ▲Signal" : ""}`).join(" · "));
  if (s.state.paperCash != null && !live) lines.push(`Paper-Guthaben (Bargeld): ${s.state.paperCash.toFixed(2)} USD`);
  return lines.join("\n");
}

async function send(token, chatId, text, fetchFn) {
  await fetchFn(api(token, "sendMessage"), { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) }) });
}

// io: { getOffset(), setOffset(n), run(command, args) -> Antworttext }
export async function pollCommands(cfg, fetchFn, io) {
  const { token, chatId, enabled } = cfg.telegram;
  if (!enabled || !token || !chatId) return;
  const stored = await io.getOffset();
  const url = `${api(token, "getUpdates")}?offset=${stored ?? 0}&timeout=0&allowed_updates=${encodeURIComponent('["message"]')}`;
  const resp = await fetchFn(url);
  if (!resp.ok) throw new Error(`Telegram HTTP ${resp.status}`);
  const body = await resp.json();
  if (!body.ok) throw new Error(`Telegram: ${body.description || "Fehler"}`);
  let next = stored ?? 0;
  for (const u of body.result) {
    next = Math.max(next, u.update_id + 1);
    if (stored == null) continue; // erster Abruf: nur den Stand merken, nichts Altes ausführen
    const m = u.message;
    if (!m || typeof m.text !== "string" || String(m.chat?.id) !== String(chatId)) continue; // fremde Chats: ignorieren, nicht antworten
    if (Date.now() / 1000 - m.date > MAX_AGE_S) continue;
    const [raw, ...args] = m.text.trim().split(/\s+/);
    const reply = await io.run(raw.split("@")[0].toLowerCase(), args);
    await send(token, chatId, reply, fetchFn);
  }
  if (stored == null || next !== stored) await io.setOffset(next);
}
