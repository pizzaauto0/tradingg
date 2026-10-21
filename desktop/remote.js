// Handy-/Browser-Zugriff: dieselbe Oberfläche (Shell, Tabs, Dashboard, Einstellungen) wird über einen kleinen Webserver ausgeliefert, der Hintergrunddienst
// (Bot, Strategien, Konto) bleibt auf dem PC. Kein Electron-Code hier – abhängig nur von Node, damit es sich ohne App testen lässt.
//
// Sicherheit: standardmäßig AUS. Zugriff nur mit langem zufälligem Schlüssel (Link/QR-Code → Cookie, SameSite=Strict); Fehlversuche werden gebremst.
// Modus "view" = nur ansehen (Lese-Nachrichten), "control" = auch handeln und Einstellungen ändern. Wallet-Geheimnisse (Anlegen, Entsperren,
// Schlüssel anzeigen/löschen) gehen NIE über diesen Zugang. Der Verkehr im WLAN ist unverschlüsselt: außerhalb des Heimnetzes nur über ein privates VPN (z. B. Tailscale).
const http = require("http");
const crypto = require("crypto");
const os = require("os");

const NEVER = new Set(["createWallet", "importWallet", "unlock", "lock", "exportKey", "deleteWallet", "balances"]);
const READ = new Set(["getStatus", "getAccount", "getProfit", "getModes", "getModeDetail", "getLiveStats", "chart", "getConfig", "discordStatus", "exportTrades"]);
const MAX_BODY = 64 * 1024;

const allowed = (mode, type) => typeof type === "string" && !NEVER.has(type) && (mode === "control" || READ.has(type));
const newKey = () => crypto.randomBytes(32).toString("base64url");
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
const same = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) for (const i of list || []) if (i.family === "IPv4" && !i.internal) out.push({ name, ip: i.address });
  return out;
}

const cookieOf = (req, name) => (req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).find(([k]) => k === name)?.[1];

// deps: { getFile(rel) -> { body, type } | null,  sendToBg(msg) -> Promise<{ok, result|error}> }
function createRemote(deps) {
  let server = null, state = { key: null, mode: "view", port: 0 };
  const fails = new Map();   // IP → [Zeitstempel falscher Schlüssel]

  const blocked = (ip) => { const a = (fails.get(ip) || []).filter((t) => Date.now() - t < 600_000); fails.set(ip, a); return a.length >= 10; };
  const fail = (ip) => { fails.set(ip, [...(fails.get(ip) || []), Date.now()]); };

  async function handle(req, res) {
    const ip = req.socket.remoteAddress || "?", url = new URL(req.url, "http://x");
    const send = (code, body, type = "text/plain; charset=utf-8", extra = {}) => {
      res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", ...extra });
      res.end(body);
    };
    if (blocked(ip)) return send(429, "Zu viele falsche Versuche – bitte in 10 Minuten erneut versuchen.");
    const qk = url.searchParams.get("key");
    let authed = false;
    if (qk != null) {   // Link mit Schlüssel: Cookie setzen und Schlüssel aus der Adresse entfernen
      if (!same(qk, state.key)) { fail(ip); return send(401, "Zugriff nur mit dem Schlüssel-Link aus der App (📱 Handy)."); }
      url.searchParams.delete("key");
      return send(302, "", "text/plain", { Location: url.pathname + (url.searchParams.size ? "?" + url.searchParams : ""), "Set-Cookie": `tb_key=${state.key}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000` });
    }
    const ck = cookieOf(req, "tb_key");
    authed = ck != null && same(ck, state.key);
    if (!authed) { if (ck != null) fail(ip); return send(401, "Zugriff nur mit dem Schlüssel-Link aus der App (📱 Handy)."); }

    if (req.method === "POST" && url.pathname === "/api/msg") {
      if (req.headers["x-tb"] !== "1" || !(req.headers["content-type"] || "").startsWith("application/json")) return send(400, '{"ok":false,"error":"Anfrage abgelehnt"}', "application/json");
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return send(403, '{"ok":false,"error":"Herkunft abgelehnt"}', "application/json");
      let size = 0; const chunks = [];
      for await (const c of req) { size += c.length; if (size > MAX_BODY) return send(413, '{"ok":false,"error":"Anfrage zu groß"}', "application/json"); chunks.push(c); }
      let msg;
      try { msg = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return send(400, '{"ok":false,"error":"Ungültige Anfrage"}', "application/json"); }
      if (!msg || typeof msg !== "object" || !allowed(state.mode, msg.type)) {
        const why = NEVER.has(msg?.type) ? "Wallet-Aktionen sind am Handy/Browser nie möglich – nur am PC." : "Im Modus „Nur ansehen“ nicht erlaubt – am PC unter 📱 Handy auf „Steuern“ stellen.";
        return send(200, JSON.stringify({ ok: false, error: why }), "application/json");
      }
      let out;
      try { out = await deps.sendToBg(msg); } catch (e) { out = { ok: false, error: e.message }; }
      return send(200, JSON.stringify(out ?? { ok: false, error: "Keine Antwort" }), "application/json");
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(405, "nicht erlaubt");
    if (url.pathname === "/api/info") return send(200, JSON.stringify({ mode: state.mode }), "application/json");
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "__shell.html";
    if (rel.includes("..") || rel.startsWith("__background")) return send(404, "nicht gefunden");
    const f = await deps.getFile(rel);
    if (!f) return send(404, "nicht gefunden");
    return send(200, f.body, f.type);
  }

  return {
    allowed,
    async start({ key, mode, port = 8787 }) {
      await this.stop();
      state = { key, mode: mode === "control" ? "control" : "view", port };
      server = http.createServer((req, res) => handle(req, res).catch((e) => { try { res.writeHead(500); res.end("Fehler: " + e.message); } catch { /* Verbindung weg */ } }));
      for (let p = port; p < port + 11; p++) {
        try { await new Promise((ok, no) => { server.once("error", no); server.listen(p === 0 ? 0 : p, "0.0.0.0", () => { server.off("error", no); ok(); }); }); state.port = server.address().port; return state.port; }
        catch (e) { if (e.code !== "EADDRINUSE" || port === 0) throw e; }
      }
      throw new Error("Kein freier Port gefunden");
    },
    async stop() { if (server) { const s = server; server = null; await new Promise((r) => { s.close(r); s.closeAllConnections?.(); }); } },
    setMode(mode) { state.mode = mode === "control" ? "control" : "view"; },
    running: () => !!server,
    port: () => state.port,
  };
}

module.exports = { createRemote, newKey, lanAddresses, allowed, NEVER, READ };
