// Discord-Bot (Gateway-Verbindung von DIESEM Rechner nach außen): beantwortet Klicks auf die Knöpfe unter dem Panel mit der Live-Statistik.
// Es wird nur ausgehend verbunden (wss://gateway.discord.gg) – der Klick kann deshalb von jedem Gerät und aus jedem Netz kommen (Handy, Mobilfunk,
// anderes WLAN); der Bot liest aber nur und handelt nie. Er muss dafür laufen (App geöffnet / PC an). Discord-Webhooks allein können keine Knöpfe.
import { buildStatsEmbed, PANEL_BUTTONS, REFRESH_BUTTONS } from "./stats.js";

const API = "https://discord.com/api/v10";
const GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json";
const VIEWS = ["stats", "positions", "trades"];

const CODES = {
  50001: "Missing Access: der Bot ist NICHT auf dem Server dieses Kanals oder sieht den Kanal nicht (Kanal-ID von einem anderen Server? Bot nicht eingeladen?)",
  50013: "Missing Permissions: dem Bot fehlen im Kanal Rechte (Kanal ansehen, Nachrichten senden, Links einbetten) – Rollen/Kanal-Berechtigungen prüfen",
  10003: "Unknown Channel: diese Kanal-ID gibt es nicht", 10004: "Unknown Guild", 50035: "Ungültige Eingabe",
  50007: "Cannot send messages to this user", 40001: "Unauthorized",
};

// Prüft Schritt für Schritt, woran es liegt: Token → Server des Bots → Kanal (Typ, Server) – für verständliche Fehlermeldungen
export async function diagnoseDiscord(token, channelId, fetchFn = fetch) {
  const get = async (path) => { const r = await fetchFn(`${API}${path}`, { headers: { authorization: `Bot ${token}` } }); return { r, j: r.ok ? await r.json().catch(() => null) : await r.json().catch(() => ({})) }; };
  const lines = [];
  const me = await get("/users/@me");
  if (!me.r.ok) return "Der Bot-Token wird von Discord abgelehnt – neuen Token unter Developer Portal → Bot → Reset Token holen.";
  lines.push(`Bot: ${me.j.username}`);
  const gs = await get("/users/@me/guilds");
  const guilds = gs.r.ok ? gs.j.map((g) => g.name) : [];
  lines.push(guilds.length ? `Der Bot ist auf diesen Servern: ${guilds.join(", ")}` : "Der Bot ist auf KEINEM Server – erst mit dem Einladungslink (OAuth2 → URL Generator, Haken „bot“) einladen.");
  const ch = await get(`/channels/${channelId}`);
  if (ch.r.ok) lines.push(`Kanal gefunden: #${ch.j.name} (Typ ${ch.j.type}${[0, 5].includes(ch.j.type) ? "" : " – das ist kein normaler Text-Kanal!"}), Server-ID ${ch.j.guild_id}`);
  else lines.push(`Kanal ${channelId} nicht lesbar (HTTP ${ch.r.status}${ch.j?.code ? ", Code " + ch.j.code : ""}): ${CODES[ch.j?.code] || ch.j?.message || "unbekannt"}`);
  return lines.join("\n");
}

export async function postPanel(token, channelId, snap, fetchFn = fetch) {
  const resp = await fetchFn(`${API}/channels/${channelId}/messages`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bot ${token}` },
    body: JSON.stringify({ content: "Drück einen Knopf für die Live-Statistik – geht von überall (Handy, anderes WLAN, Mobilfunk), solange die App auf dem PC läuft. Nur Ansehen, der Knopf handelt nie.",
      embeds: [buildStatsEmbed(snap, "stats")], components: PANEL_BUTTONS, allowed_mentions: { parse: [] } }) });
  if (resp.ok) return true;
  const body = await resp.json?.().catch(() => ({})) ?? {};
  let diag = "";
  try { diag = await diagnoseDiscord(token, channelId, fetchFn); } catch { /* Diagnose ist nur Zugabe */ }
  throw new Error(`Discord HTTP ${resp.status}${body.code ? ` (Code ${body.code})` : ""}: ${CODES[body.code] || body.message || (resp.status === 401 ? "Bot-Token falsch" : "abgelehnt")}${diag ? "\n\nDiagnose:\n" + diag : ""}`);
}

export class DiscordBot {
  // opts: { token, channelId, getSnapshot(), fetchFn, WS }
  constructor(opts) {
    Object.assign(this, { fetchFn: fetch, WS: globalThis.WebSocket }, opts);
    const raw = this.fetchFn;
    this.fetchFn = (...a) => raw(...a);   // nie als Methode aufrufen: fetch verlangt window/undefined als this („Illegal invocation“)
    this.state = "gestoppt"; this.error = null; this.ws = null; this.seq = null; this.hb = null; this.stopped = true; this.retry = 0; this.answered = 0;
  }

  start() { this.stopped = false; this.connect(); }

  stop() {
    this.stopped = true; this.state = "gestoppt";
    clearInterval(this.hb); clearTimeout(this.timer);
    try { this.ws?.close(1000); } catch { /* schon zu */ }
    this.ws = null;
  }

  connect() {
    if (this.stopped) return;
    this.state = "verbindet …";
    let ws;
    try { ws = this.ws = new this.WS(GATEWAY); } catch (e) { return this.fail(e.message); }
    ws.onmessage = (ev) => this.onMessage(ws, JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)));
    ws.onclose = (ev) => {
      clearInterval(this.hb);
      if (this.stopped || ws !== this.ws) return;
      if (ev.code === 4004) { this.error = "Bot-Token ungültig"; this.state = "Fehler"; this.stopped = true; return; }   // nicht erneut versuchen
      this.state = "getrennt – verbindet neu";
      this.timer = setTimeout(() => this.connect(), Math.min(60_000, 2000 * 2 ** this.retry++));
    };
    ws.onerror = () => { this.error = "Verbindungsfehler"; };
  }

  fail(msg) { this.error = msg; this.state = "Fehler"; this.timer = setTimeout(() => this.connect(), Math.min(60_000, 2000 * 2 ** this.retry++)); }

  onMessage(ws, m) {
    if (m.s != null) this.seq = m.s;
    if (m.op === 10) {   // Hello: Herzschlag starten und anmelden. Intents 0 genügen, Interaktionen (Knopfklicks) kommen immer an.
      clearInterval(this.hb);
      this.hb = setInterval(() => ws.send(JSON.stringify({ op: 1, d: this.seq })), m.d.heartbeat_interval);
      ws.send(JSON.stringify({ op: 2, d: { token: this.token, intents: 0, properties: { os: "desktop", browser: "trading-bot", device: "trading-bot" } } }));
    } else if (m.op === 7 || m.op === 9) {   // Neustart verlangt / Sitzung ungültig
      try { ws.close(4000); } catch { /* egal */ }
    } else if (m.op === 0 && m.t === "READY") {
      this.state = "verbunden"; this.error = null; this.retry = 0; this.user = m.d.user?.username;
    } else if (m.op === 0 && m.t === "INTERACTION_CREATE") {
      this.onInteraction(m.d).catch((e) => { this.error = e.message; });
    }
  }

  async onInteraction(i) {
    if (i.type !== 3) return;   // nur Knopfklicks (MESSAGE_COMPONENT)
    const view = i.data?.custom_id;
    if (!VIEWS.includes(view)) return;
    const send = (body) => this.fetchFn(`${API}/interactions/${i.id}/${i.token}/callback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (this.channelId && i.channel_id !== this.channelId) {   // nur im eingerichteten Kanal antworten
      await send({ type: 4, data: { content: "Dieser Bot antwortet nur im eingerichteten Kanal.", flags: 64 } });
      return;
    }
    let data;
    try { data = { embeds: [buildStatsEmbed(await this.getSnapshot(), view)], components: REFRESH_BUTTONS(view), allowed_mentions: { parse: [] } }; }
    catch (e) { data = { content: `Statistik gerade nicht verfügbar: ${e.message}` }; }
    const ephemeral = ((i.message?.flags ?? 0) & 64) !== 0;   // Klick in einer privaten Antwort aktualisiert diese; Klick im Panel öffnet eine neue private Antwort
    const resp = await send(ephemeral ? { type: 7, data } : { type: 4, data: { ...data, flags: 64 } });
    if (!resp.ok) throw new Error(`Discord HTTP ${resp.status} beim Antworten`);
    this.answered++;
  }

  status() { return { state: this.state, error: this.error, user: this.user || null, answered: this.answered }; }
}
