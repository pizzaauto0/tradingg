const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { createRemote, newKey, allowed } = require("../remote");

const files = { "__shell.html": { body: "<html>shell</html>", type: "text/html" }, "popup.html": { body: "<html>popup</html>", type: "text/html" }, "__shim.js": { body: "//remote", type: "text/javascript" } };
const sent = [];
function make() {
  return createRemote({ getFile: async (rel) => files[rel] || null, sendToBg: async (msg) => { sent.push(msg); return { ok: true, result: { echo: msg.type } }; } });
}
function req(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: d })); });
    r.on("error", reject); if (body) r.write(body); r.end();
  });
}
async function login(port, key) {
  const r = await req(port, { path: `/?key=${key}` });
  return { r, cookie: (r.headers["set-cookie"] || [""])[0].split(";")[0] };
}

test("Nachrichten-Erlaubnis: Ansehen, Steuern, Wallet nie", () => {
  assert.ok(allowed("view", "getStatus") && allowed("view", "getModes") && allowed("view", "getOverview") && allowed("view", "exportTrades"));
  assert.ok(!allowed("view", "buy") && !allowed("view", "saveConfig") && !allowed("view", "killAll"));
  assert.ok(allowed("control", "buy") && allowed("control", "killAll") && allowed("control", "saveConfig"));
  for (const t of ["createWallet", "importWallet", "unlock", "lock", "exportKey", "deleteWallet", "balances"]) assert.ok(!allowed("control", t) && !allowed("view", t), t);
  assert.ok(!allowed("control", undefined) && !allowed("control", 5));
});

test("Zugang: ohne Schlüssel nichts, mit Schlüssel Cookie + Weiterleitung ohne Schlüssel in der Adresse", async () => {
  const key = newKey(), srv = make(), port = await srv.start({ key, mode: "view", port: 0 });
  try {
    assert.equal((await req(port)).status, 401);
    assert.equal((await req(port, { path: "/popup.html" })).status, 401);
    const { r, cookie } = await login(port, key);
    assert.equal(r.status, 302); assert.equal(r.headers.location, "/"); assert.match(r.headers["set-cookie"][0], /HttpOnly; SameSite=Strict/);
    const page = await req(port, { headers: { cookie } });
    assert.equal(page.status, 200); assert.equal(page.body, "<html>shell</html>"); assert.match(page.headers["cache-control"], /no-store/);
    assert.equal((await req(port, { path: "/popup.html?bot=fx", headers: { cookie } })).body, "<html>popup</html>");
    assert.equal((await req(port, { path: "/lib/../../etc/passwd", headers: { cookie } })).status, 404);
    assert.equal((await req(port, { path: "/__background.html", headers: { cookie } })).status, 404);
    assert.equal((await req(port, { path: "/gibtsnicht.js", headers: { cookie } })).status, 404);
    assert.equal((await req(port, { headers: { cookie: "tb_key=falsch" } })).status, 401);
  } finally { await srv.stop(); }
});

test("Nachrichten: Ansehen erlaubt Lesen, blockt Handeln; Steuern erlaubt Handeln, Wallet nie; CSRF-Schutz", async () => {
  const key = newKey(), srv = make(), port = await srv.start({ key, mode: "view", port: 0 });
  try {
    const { cookie } = await login(port, key);
    const post = (msg, extra = {}) => req(port, { method: "POST", path: "/api/msg", headers: { cookie, "content-type": "application/json", "x-tb": "1", ...extra }, body: JSON.stringify(msg) });
    sent.length = 0;
    assert.deepEqual(JSON.parse((await post({ type: "getProfit" })).body), { ok: true, result: { echo: "getProfit" } });
    const denied = JSON.parse((await post({ type: "buy", symbol: "X" })).body);
    assert.equal(denied.ok, false); assert.match(denied.error, /Nur ansehen/); assert.equal(sent.length, 1);
    srv.setMode("control");
    assert.equal(JSON.parse((await post({ type: "buy", symbol: "X" })).body).ok, true);
    const wallet = JSON.parse((await post({ type: "exportKey", password: "x" })).body);
    assert.equal(wallet.ok, false); assert.match(wallet.error, /Wallet/); assert.equal(sent.at(-1).type, "buy");
    assert.equal((await post({ type: "getStatus" }, { "x-tb": "0" })).status, 400, "ohne Kopfzeile X-TB abgelehnt");
    assert.equal((await post({ type: "getStatus" }, { origin: "http://boese.example", host: "127.0.0.1:" + port })).status, 403, "fremde Herkunft");
    assert.equal((await req(port, { method: "POST", path: "/api/msg", headers: { "content-type": "application/json", "x-tb": "1" }, body: "{}" })).status, 401, "ohne Cookie");
    assert.equal((await post("kaputt{")).status, 200);   // gültiges JSON (String) → abgelehnt als nicht erlaubt
    assert.equal((await req(port, { method: "POST", path: "/api/msg", headers: { cookie, "content-type": "application/json", "x-tb": "1" }, body: "{" })).status, 400);
    assert.equal((await req(port, { method: "POST", path: "/api/msg", headers: { cookie, "content-type": "application/json", "x-tb": "1" }, body: "x".repeat(70_000) })).status, 413);
  } finally { await srv.stop(); }
});

test("Falsche Schlüssel werden gebremst; neuer Start mit neuem Schlüssel macht alte Cookies ungültig", async () => {
  const key = newKey(), srv = make(), port = await srv.start({ key, mode: "view", port: 0 });
  try {
    const { cookie } = await login(port, key);
    for (let i = 0; i < 10; i++) assert.equal((await req(port, { path: "/?key=falsch" + i })).status, 401);
    assert.equal((await req(port, { path: "/?key=falsch" })).status, 429, "nach 10 Fehlversuchen gesperrt");
    assert.equal((await req(port, { headers: { cookie } })).status, 429, "auch mit gutem Cookie von derselben Adresse (10 Minuten)");
  } finally { await srv.stop(); }
  const k1 = newKey(), k2 = newKey(), s2 = make(), p2 = await s2.start({ key: k1, mode: "view", port: 0 });
  try {
    const { cookie } = await login(p2, k1);
    await s2.start({ key: k2, mode: "view", port: 0 });
    assert.equal((await req(s2.port(), { headers: { cookie } })).status, 401, "alter Schlüssel gilt nicht mehr");
  } finally { await s2.stop(); }
  assert.equal(s2.running(), false);
});
