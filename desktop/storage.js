// Ersatz für chrome.storage: "local" liegt dauerhaft in einer JSON-Datei, "session" nur im Speicher (weg beim Beenden der App).
const fs = require("fs");
const path = require("path");

class Store {
  constructor(file) {
    this.file = file;
    this.local = {};
    this.session = {};
    this.timer = null;
    try { this.local = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch { this.local = {}; }
  }
  area(name) {
    if (name !== "local" && name !== "session") throw new Error(`Unbekannter Speicherbereich: ${name}`);
    return this[name];
  }
  get(name, keys) {
    const a = this.area(name), out = {};
    if (keys == null) return JSON.parse(JSON.stringify(a));
    if (typeof keys === "string") keys = [keys];
    if (Array.isArray(keys)) { for (const k of keys) if (k in a) out[k] = a[k]; }
    else for (const [k, def] of Object.entries(keys)) out[k] = k in a ? a[k] : def;   // Objekt = Schlüssel mit Standardwerten
    return JSON.parse(JSON.stringify(out));
  }
  set(name, obj) {
    const a = this.area(name);
    for (const [k, v] of Object.entries(obj || {})) { if (v === undefined) delete a[k]; else a[k] = JSON.parse(JSON.stringify(v)); }
    if (name === "local") this.save();
  }
  remove(name, keys) {
    const a = this.area(name);
    for (const k of Array.isArray(keys) ? keys : [keys]) delete a[k];
    if (name === "local") this.save();
  }
  clear(name) {
    this.area(name);
    this[name] = {};
    if (name === "local") this.save();
  }
  save() {   // gebündelt und atomar schreiben, damit ein Absturz keine halbe Datei hinterlässt
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 200);
  }
  flush() {
    clearTimeout(this.timer);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.local));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store };
