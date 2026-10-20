// Brücke zwischen den Seiten der Erweiterung und dem Hauptprozess (contextIsolation bleibt an, nur diese Funktionen sind sichtbar).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronBridge", {
  storage: (op, area, arg) => ipcRenderer.invoke("storage", op, area, arg),
  send: (msg) => ipcRenderer.invoke("rt:send", msg),
  onMessage: (cb) => ipcRenderer.on("rt:message", (_e, id, msg) => cb(msg, (resp) => ipcRenderer.send("rt:reply", id, resp))),
  tip: (text) => ipcRenderer.send("tip", String(text).slice(0, 120)),
  diag: () => ipcRenderer.invoke("diag"),
  notify: (opts) => ipcRenderer.send("notify", opts),
  badge: (opts) => ipcRenderer.send("badge", opts),
  open: (name, query) => ipcRenderer.send("open", name, query),
});
