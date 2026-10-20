const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Store } = require("../storage");

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tb-")), "storage.json");

test("get/set/remove wie chrome.storage", () => {
  const s = new Store(tmp());
  s.set("local", { a: 1, b: { c: [1, 2] } });
  assert.deepEqual(s.get("local", "a"), { a: 1 });
  assert.deepEqual(s.get("local", ["a", "zz"]), { a: 1 });
  assert.deepEqual(s.get("local", { a: 9, d: 5 }), { a: 1, d: 5 });
  assert.deepEqual(Object.keys(s.get("local", null)).sort(), ["a", "b"]);
  s.remove("local", "a");
  assert.deepEqual(s.get("local", ["a"]), {});
  const copy = s.get("local", "b"); copy.b.c.push(3);
  assert.deepEqual(s.get("local", "b").b.c, [1, 2]);   // Kopien, keine Verweise
});

test("local bleibt erhalten, session nicht", () => {
  const f = tmp();
  const s = new Store(f);
  s.set("local", { key: "x" }); s.set("session", { unlocked: "k" });
  s.flush();
  const s2 = new Store(f);
  assert.equal(s2.get("local", "key").key, "x");
  assert.deepEqual(s2.get("session", null), {});
});

test("clear und unbekannter Bereich", () => {
  const s = new Store(tmp());
  s.set("local", { a: 1 }); s.clear("local");
  assert.deepEqual(s.get("local", null), {});
  assert.throws(() => s.get("sync", "a"));
});

test("kaputte Datei startet leer", () => {
  const f = tmp(); fs.writeFileSync(f, "{kaputt");
  assert.deepEqual(new Store(f).get("local", null), {});
});
