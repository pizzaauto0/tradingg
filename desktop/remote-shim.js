// Gegenstück zu chrome-shim.js für Handy/Browser: dieselben Seiten der App, aber die Nachrichten an den Hintergrunddienst gehen per HTTP an den PC.
(() => {
  window.__REMOTE = true;
  const showError = (text) => {
    try {
      let box = document.getElementById("__err");
      if (!box) { box = document.createElement("pre"); box.id = "__err"; box.style.cssText = "position:fixed;z-index:99999;top:0;left:0;right:0;margin:0;padding:8px 12px;background:#7a1f1f;color:#fff;font:12px/1.4 monospace;white-space:pre-wrap;max-height:40vh;overflow:auto"; (document.body || document.documentElement).append(box); }
      if (box.textContent.length < 1500) box.textContent += (box.textContent ? "\n" : "") + text;
    } catch { /* nichts mehr zu tun */ }
  };
  addEventListener("error", (e) => showError(`Fehler: ${e.message} (${String(e.filename).split("/").pop()}:${e.lineno})`));
  addEventListener("unhandledrejection", (e) => showError(`Fehler: ${e.reason?.message || e.reason}`));
  const style = document.createElement("style");
  style.textContent = "body.popup{width:auto!important;max-width:1100px;margin:0 auto}";
  document.documentElement.append(style);

  async function send(msg) {
    let r;
    try { r = await fetch("/api/msg", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-TB": "1" }, body: JSON.stringify(msg) }); }
    catch { return { ok: false, error: "PC nicht erreichbar – läuft die App und ist das WLAN/VPN verbunden?" }; }
    if (r.status === 401) return { ok: false, error: "Nicht angemeldet – den Link/QR-Code aus der App (📱 Handy) erneut öffnen." };
    if (r.status === 429) return { ok: false, error: "Zu viele falsche Versuche – später erneut versuchen." };
    try { return await r.json(); } catch { return { ok: false, error: `Antwort nicht lesbar (HTTP ${r.status})` }; }
  }
  const empty = { get: async () => ({}), set: async () => {}, remove: async () => {}, clear: async () => {} };
  window.chrome = {
    runtime: {
      id: "trading-bot-remote", getURL: (p) => "/" + String(p).replace(/^\/+/, ""), openOptionsPage: () => window.open("/options.html", "_blank"),
      sendMessage: send, onMessage: { addListener: () => {} }, onInstalled: { addListener: () => {} }, onStartup: { addListener: () => {} },
    },
    storage: { local: empty, session: empty },
    alarms: { create: () => {}, get: async () => undefined, onAlarm: { addListener: () => {} } },
    notifications: { create: () => {} },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    tabs: { create: async ({ url }) => { window.open(url, "_blank"); } },
    permissions: { contains: async () => true, request: async () => true },
  };
})();
