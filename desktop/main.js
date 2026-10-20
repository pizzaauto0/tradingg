// Desktop-App: lädt die unveränderte Chrome-Erweiterung (../extension) in Electron-Fenstern.
// Hintergrund-Fenster (unsichtbar) = Service Worker (alle 30 s ein Durchlauf); Hauptfenster = Popup; weitere: Dashboard, Einstellungen.
const { app, BrowserWindow, ipcMain, protocol, session, Tray, Menu, Notification, nativeImage, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const { Store } = require("./storage");

const EXT = app.isPackaged ? path.join(process.resourcesPath, "ext") : path.join(__dirname, "..", "extension");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".png": "image/png", ".json": "application/json", ".svg": "image/svg+xml" };
const PAGES = {
  main: { url: "app://ext/__shell.html", width: 1100, height: 860, title: "Trading-Bot" },
  dashboard: { url: "app://ext/dashboard.html", width: 1240, height: 860, title: "Trading-Bot – Dashboard" },
  options: { url: "app://ext/options.html", width: 960, height: 860, title: "Trading-Bot – Einstellungen" },
};
const BACKGROUND_HTML = '<!doctype html><meta charset="utf-8"><script src="__shim.js"></script><script type="module" src="background.js"></script>';

protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

let store, bg, tray, quitting = false, bgReady;
const errors = [];   // letzte Fehler aller Fenster (für die Diagnose in der App und app.log)
const SLOW = new Set(["research", "tickNow", "kill", "killAll", "testTrade", "buy", "sell", "balances", "start", "startAll", "stopAll", "postDiscordPanel", "testDiscord", "testDiscordLog"]);
function note(kind, text) {
  const line = `${new Date().toISOString()} ${kind}: ${text}`;
  errors.push(line); if (errors.length > 60) errors.shift();
  try { fs.appendFileSync(path.join(app.getPath("userData"), "app.log"), line + "\n"); } catch { /* Protokoll ist nur Zugabe */ }
}
const watch = (win, name) => {
  win.webContents.on("before-input-event", (e, i) => { if (i.type === "keyDown" && (i.key === "F12" || (i.control && i.shift && i.key.toLowerCase() === "i"))) { win.webContents.toggleDevTools(); e.preventDefault(); } });   // Entwicklerwerkzeuge (Fehlersuche)
  win.webContents.on("console-message", (_e, level, message, line, source) => { if (level >= 2 && !/Electron Security Warning/.test(message)) note(`Fehler in ${name}`, `${message} (${String(source).split("/").slice(-2).join("/")}:${line})`); });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => note(`Laden fehlgeschlagen in ${name}`, `${desc} (${code}) ${url}`));
  win.webContents.on("render-process-gone", (_e, d) => note(`Prozess beendet in ${name}`, d.reason));
};
const windows = {};
const pending = new Map();
let nextId = 1;

const injectShim = (html) => html.replace(/<head[^>]*>/i, (m) => `${m}<script src="__shim.js"></script>`);   // Shim vor allen anderen Skripten einsetzen

// Discord lehnt Anfragen ab, die wie aus einem Browser aussehen (Fehler 40333 „internal network error“): Bots müssen sich mit einem
// DiscordBot-User-Agent melden und dürfen keinen Origin/Referer senden. Für Discord-Adressen setzen wir deshalb die Kopfzeilen eines normalen Bot-Clients.
const DISCORD_UA = "DiscordBot (https://github.com/pizzaauto0/tradingg, 1.0)";
function installDiscordHeaders() {
  const urls = ["https://discord.com/api/*", "https://discordapp.com/api/*", "wss://gateway.discord.gg/*"];
  if (process.env.TB_TEST_HEADER_URL) urls.push(process.env.TB_TEST_HEADER_URL);   // nur für Tests
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls }, (details, callback) => {
    const h = { ...details.requestHeaders };
    for (const k of Object.keys(h)) if (/^(origin|referer|sec-fetch-.*|sec-ch-ua.*)$/i.test(k)) delete h[k];
    h["User-Agent"] = DISCORD_UA;
    callback({ requestHeaders: h });
  });
}

// Log-Dateien älter als 30 Tage werden beim Start gelöscht (sonst wächst der Ordner endlos)
function pruneLogs() {
  const root = path.join(app.getPath("userData"), "logs"), limit = Date.now() - 30 * 86400000;
  const walk = (d) => { try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (fs.statSync(p).mtimeMs < limit) fs.unlinkSync(p); } } catch { /* Ordner fehlt */ } };
  walk(root);
}

function serve(request) {
  const u = new URL(request.url);
  const rel = decodeURIComponent(u.pathname).replace(/^\/+/, "");
  if (u.host !== "ext") return new Response("nicht gefunden", { status: 404 });
  const type = (p) => MIME[path.extname(p).toLowerCase()] || "application/octet-stream";
  const send = (body, p) => new Response(body, { headers: { "Content-Type": type(p), "Cache-Control": "no-store" } });
  if (rel === "__shim.js") return send(fs.readFileSync(path.join(__dirname, "chrome-shim.js")), "x.js");
  if (rel === "__shell.js") return send(fs.readFileSync(path.join(__dirname, "shell.js")), "x.js");
  if (rel === "__shell.html") return send(injectShim(fs.readFileSync(path.join(__dirname, "shell.html"), "utf8")), "x.html");
  if (rel === "__background.html") return send(BACKGROUND_HTML, "x.html");
  const file = path.normalize(path.join(EXT, rel));
  if (!file.startsWith(EXT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response("nicht gefunden", { status: 404 });
  if (path.extname(file) === ".html") {   // Shim vor allen anderen Skripten einsetzen
    return send(injectShim(fs.readFileSync(file, "utf8")), file);
  }
  return send(fs.readFileSync(file), file);
}

const webPrefs = () => ({
  preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true,
  webSecurity: false,   // die Seiten rufen Börsen-/Telegram-APIs direkt auf (in Chrome erlaubt das host_permissions); es wird nur eigener Code geladen
});

function lockdown(win) {
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("app://ext/")) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
}

function openPage(name, { show = true, query = "" } = {}) {
  const spec = PAGES[name];
  if (!spec) return;
  query = /^\?bot=(fx|metals|crypto)$/.test(query) ? query : "";   // nur bekannte Bots als Parameter
  const key = name + query;
  let win = windows[key];
  if (win && !win.isDestroyed()) { if (show) { win.show(); win.focus(); } return win; }
  win = new BrowserWindow({ width: spec.width, height: spec.height, title: spec.title, show, icon: path.join(__dirname, "icon.png"), backgroundColor: "#0d1117", webPreferences: webPrefs() });
  lockdown(win);
  watch(win, name);
  win.removeMenu?.();
  win.on("close", (e) => { if (name === "main" && !quitting) { e.preventDefault(); win.hide(); } });   // Hauptfenster schließen = im Hintergrund weiterlaufen
  win.loadURL(spec.url + query);
  windows[key] = win;
  return win;
}

function startBackground() {
  bg = new BrowserWindow({ show: false, webPreferences: { ...webPrefs(), backgroundThrottling: false } });
  watch(bg, "Hintergrunddienst");
  let retries = 0;
  bg.webContents.on("did-fail-load", (_e, code, desc, url) => { console.error("Hintergrunddienst konnte nicht laden:", code, desc, url); if (retries++ < 3) setTimeout(() => bg.loadURL("app://ext/__background.html").catch(() => {}), 2000); });
  bgReady = new Promise((res) => bg.webContents.once("did-finish-load", res));
  bg.loadURL(process.env.TB_BREAK ? "app://ext/nope.html" : "app://ext/__background.html").catch((e) => console.error("Hintergrunddienst loadURL:", e.message));
}

function setupIpc() {
  ipcMain.handle("storage", (_e, op, area, arg) => {
    if (op === "get") return store.get(area, arg);
    if (op === "set") return store.set(area, arg);
    if (op === "remove") return store.remove(area, arg);
    if (op === "clear") return store.clear(area);
    throw new Error("Unbekannte Speicher-Operation");
  });
  ipcMain.handle("rt:send", async (_e, msg) => {
    await bgReady;
    return new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: "Der Hintergrunddienst antwortet nicht (Zeitüberschreitung). Menü Ansicht → Entwicklerwerkzeuge zeigt den Fehler; Protokoll: app.log im Datenordner." }); }, SLOW.has(msg?.type) ? 300000 : 20000);
      pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
      bg.webContents.send("rt:message", id, msg);
    });
  });
  ipcMain.handle("diag", () => ({
    version: app.getVersion(), packaged: app.isPackaged, ext: EXT, extExists: fs.existsSync(EXT), userData: app.getPath("userData"), platform: process.platform + " " + process.arch,
    electron: process.versions.electron, bgUrl: bg && !bg.isDestroyed() ? bg.webContents.getURL() : null, bgLoading: bg && !bg.isDestroyed() ? bg.webContents.isLoading() : null,
    storageKeys: Object.keys(store.get("local", null) || {}), errors: errors.slice(-15),
  }));
  ipcMain.on("rt:reply", (_e, id, resp) => { const fn = pending.get(id); if (fn) { pending.delete(id); fn(resp); } });
  ipcMain.on("notify", (_e, o) => { if (Notification.isSupported()) new Notification({ title: String(o.title || "Trading-Bot"), body: String(o.message || "") }).show(); });
  ipcMain.on("badge", (_e, { text }) => { tray?.setToolTip(`Trading-Bot${text ? " – " + text : ""}`); windows.main?.setTitle(`Trading-Bot${text ? " [" + text + "]" : ""}`); });
  // Log-Dateien der Modi (Stunden- und 6-Stunden-Berichte): nur unterhalb von <Datenordner>/logs, nur harmlose Dateinamen
  const logDir = () => path.join(app.getPath("userData"), "logs");
  ipcMain.handle("log:write", (_e, rel, text) => {
    rel = String(rel);
    if (!/^[\w\-./]{1,160}$/.test(rel) || rel.includes("..") || rel.startsWith("/")) throw new Error("Ungültiger Logname");
    const f = path.join(logDir(), rel);
    if (!f.startsWith(logDir() + path.sep)) throw new Error("Ungültiger Logpfad");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, String(text).slice(0, 300000));
    return true;
  });
  ipcMain.handle("log:open", () => { fs.mkdirSync(logDir(), { recursive: true }); return shell.openPath(logDir()); });
  ipcMain.on("tip", (_e, text) => { tray?.setToolTip(text); });   // Tooltip des Infobereich-Symbols: Gewinn auf einen Blick
  ipcMain.on("open", (_e, name, query) => openPage(String(name), { query: String(query || "") }));
}

function setupTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, "icon.png")).resize({ width: 16, height: 16 }));
  tray.setToolTip("Trading-Bot");
  const menu = () => Menu.buildFromTemplate([
    { label: "Öffnen", click: () => openPage("main") },
    { label: "Dashboard (Krypto)", click: () => openPage("dashboard") },
    { label: "Einstellungen (Krypto)", click: () => openPage("options") },
    { type: "separator" },
    { label: "Beim Windows-Start automatisch starten", type: "checkbox", checked: app.getLoginItemSettings().openAtLogin,
      click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked, args: ["--background"] }) },
    { type: "separator" },
    { label: "Beenden (Bot stoppt)", click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu());
  tray.on("click", () => openPage("main"));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => openPage("main"));
  app.whenReady().then(() => {
    store = new Store(path.join(app.getPath("userData"), "storage.json"));
    protocol.handle("app", serve);
    installDiscordHeaders();
    pruneLogs();
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "editMenu" }, { role: "viewMenu" }]));
    setupIpc();
    startBackground();
    setupTray();
    openPage("main", { show: !process.argv.includes("--background") });
  });
  app.on("before-quit", () => { quitting = true; store?.flush(); });
  app.on("window-all-closed", () => {});   // läuft über das Tray-Symbol weiter
}
