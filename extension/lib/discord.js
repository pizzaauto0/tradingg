// Meldungen per Discord-Webhook (nur Senden, kein Empfangen). Fehler beim Senden dürfen den Bot nie stoppen.
const LIMIT = 1900; // Discord erlaubt 2000 Zeichen je Nachricht

export function chunkText(text, size = LIMIT) {
  const out = [];
  let cur = "";
  for (let line of String(text).split("\n")) {
    while (line.length > size) { if (cur) { out.push(cur); cur = ""; } out.push(line.slice(0, size)); line = line.slice(size); }
    if (cur.length + line.length + 1 > size) { out.push(cur); cur = ""; }
    cur += (cur ? "\n" : "") + line;
  }
  if (cur) out.push(cur);
  return out;
}

// Hübschere Köpfe für die wichtigsten Ereignisse (Kauf/Verkauf/Warnung).
export function decorate(text) {
  if (/^ENTRY /.test(text)) return text.replace(/^ENTRY /, "🟢 **KAUF** ");
  if (/^TESTTRADE /.test(text)) return text.replace(/^TESTTRADE /, "🧪 **TESTKAUF** ");
  if (/^EXIT /.test(text)) return text.replace(/^EXIT /, /Ergebnis \+/.test(text) ? "✅ **VERKAUF** " : "🔴 **VERKAUF** ");
  if (/^TRAIL /.test(text)) return text.replace(/^TRAIL /, "🔒 **STOP NACHGEZOGEN** ");
  if (/^STOP\/ZIEL /.test(text)) return text.replace(/^STOP\/ZIEL /, "🔧 ");
  if (/^NOT-AUS/.test(text)) return "🛑 " + text;
  if (/^(WARNUNG|Tagesverlust)/.test(text)) return "⚠️ " + text;
  return text;
}

// ---- Protokoll-Kanal: viele kleine Zeilen werden gesammelt und gebündelt gesendet (Discord erlaubt nur wenige Anfragen pro Sekunde) ----
const logQueue = new Map();
export function queueLog(webhook, line) {
  const q = logQueue.get(webhook) || [];
  q.push(line);
  logQueue.set(webhook, q.slice(-400));   // Obergrenze, falls Discord nicht erreichbar ist
}

export async function flushLogs(fetchFn = fetch) {
  for (const [hook, lines] of [...logQueue]) {
    logQueue.delete(hook);
    for (const part of chunkText(lines.join("\n"), 1850)) {
      try { await sendDiscord(hook, "```\n" + part.replaceAll("```", "ʼʼʼ") + "\n```", fetchFn, "Trading-Bot Log"); }
      catch (e) { console.warn("Discord-Log:", e.message); break; }
    }
  }
}

export async function sendDiscord(webhook, text, fetchFn = fetch, username = "Trading-Bot") {
  for (const part of chunkText(text)) {
    const resp = await fetchFn(webhook, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, content: part, allowed_mentions: { parse: [] } }) });
    if (!resp.ok) throw new Error(`Discord HTTP ${resp.status}`);
  }
}
