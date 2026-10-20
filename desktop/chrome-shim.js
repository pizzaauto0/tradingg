// Stellt die wenigen chrome.*-Funktionen bereit, die die Erweiterung nutzt (storage, runtime, alarms, notifications, action, tabs, permissions).
// Wird vor allen Skripten jeder Seite geladen. Die Erweiterung selbst bleibt unverändert.
(() => {
  const B = window.electronBridge || window.parent.electronBridge;   // in eingebetteten Tabs (iframe) liegt die Brücke im Elternfenster (gleicher Ursprung)
  const RUNTIME_ID = "trading-bot-desktop";
  const pageOf = (url) => { const m = /\/([a-z]+)\.html(\?[^#]*)?/.exec(String(url)); return m ? [m[1], m[2] || ""] : [null, ""]; };
  // Die Seiten der Erweiterung sind für ein schmales Popup gebaut; im Fenster dürfen sie breiter werden
  const style = document.createElement("style");
  style.textContent = "body.popup{width:auto!important;max-width:1100px;margin:0 auto}";
  document.documentElement.append(style);
  const area = (name) => ({
    get: (keys) => B.storage("get", name, keys == null ? null : keys),
    set: (obj) => B.storage("set", name, obj),
    remove: (keys) => B.storage("remove", name, keys),
    clear: () => B.storage("clear", name),
  });
  // Fehler sichtbar machen statt leerer Seite: erster Fehler als roter Kasten oben (hilft bei der Fehlersuche)
  const showError = (text) => {
    try {
      let box = document.getElementById("__err");
      if (!box) { box = document.createElement("pre"); box.id = "__err"; box.style.cssText = "position:fixed;z-index:99999;top:0;left:0;right:0;margin:0;padding:8px 12px;background:#7a1f1f;color:#fff;font:12px/1.4 monospace;white-space:pre-wrap;max-height:40vh;overflow:auto"; (document.body || document.documentElement).append(box); }
      if (box.textContent.length < 1500) box.textContent += (box.textContent ? "\n" : "") + text;
    } catch { /* nichts mehr zu tun */ }
  };
  addEventListener("error", (e) => showError(`Fehler: ${e.message} (${String(e.filename).split("/").pop()}:${e.lineno})`));
  addEventListener("unhandledrejection", (e) => showError(`Fehler: ${e.reason?.message || e.reason}`));
  const listeners = [];
  let messageHooked = false;
  const alarms = new Map(), alarmListeners = [];
  window.chrome = {
    runtime: {
      id: RUNTIME_ID,
      getURL: (p) => `app://ext/${String(p).replace(/^\/+/, "")}`,
      openOptionsPage: () => B.open("options", ""),
      sendMessage: (msg) => B.send(msg),
      onMessage: {
        addListener: (fn) => {
          listeners.push(fn);
          if (messageHooked) return;
          messageHooked = true;
          B.onMessage((msg, reply) => {
            let async = false;
            const respond = (r) => reply(r);
            for (const fn of listeners) { if (fn(msg, { id: RUNTIME_ID }, respond) === true) async = true; }
            if (!async) reply(undefined);
          });
        },
      },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
    },
    storage: { local: area("local"), session: area("session") },
    alarms: {
      create: (name, info) => {
        clearInterval(alarms.get(name)?.timer);
        const ms = Math.max(1000, (info.periodInMinutes || info.delayInMinutes || 1) * 60000);
        const timer = setInterval(() => alarmListeners.forEach((fn) => fn({ name })), ms);
        alarms.set(name, { name, timer });
      },
      get: async (name) => (alarms.has(name) ? { name } : undefined),
      onAlarm: { addListener: (fn) => alarmListeners.push(fn) },
    },
    notifications: { create: (opts) => { B.notify({ title: opts.title, message: opts.message }); } },
    action: {
      setBadgeText: async ({ text }) => B.badge({ text }),
      setBadgeBackgroundColor: async () => {},
    },
    tabs: { create: async ({ url }) => { const [name, query] = pageOf(url); B.open(name || "dashboard", query); } },
    permissions: { contains: async () => true, request: async () => true },   // eine Desktop-App hat keine Host-Berechtigungen zu erfragen
  };
})();
