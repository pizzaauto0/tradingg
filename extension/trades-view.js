// Dashboard-Reiter „Bisherige Trades“: Liste links, rechts der Chart des gewählten Trades mit Einstieg, Ausstieg und dem Verlauf von Stop-Loss und Ziel.
import { strategyLabel, stamp } from "./lib/names.js";
import { levelSteps } from "./lib/history.js";
const BOT = new URLSearchParams(location.search).get("bot") || "crypto";
const call = async (type, extra = {}) => { const r = await chrome.runtime.sendMessage({ type, bot: BOT, ...extra }); if (!r?.ok) throw new Error(r?.error); return r.result; };
const $ = (id) => document.getElementById(id);
const h = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v); }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return e;
};
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const fmt = (x, d = 2) => (x == null || !isFinite(x) ? "–" : Math.abs(x) >= 1000 ? x.toLocaleString("de-DE", { maximumFractionDigits: d }) : x.toFixed(Math.abs(x) < 1 ? 5 : d));
const sg = (x, d = 2) => (x >= 0 ? "+" : "") + fmt(x, d);
const pc = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(1).replace(".", ",")} %`;
const dur = (ms) => { const m = Math.round(ms / 60000); return m < 90 ? `${m} Min` : m < 48 * 60 ? `${(m / 60).toFixed(1).replace(".", ",")} Std` : `${(m / 1440).toFixed(1).replace(".", ",")} Tage`; };
const hhmm = (ts) => new Date(ts).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

let trades = [], sel = null, cdl = null, filter = "all", market = "all", hover = null, loaded = false, tfName = "";

function setView(v) {
  document.querySelectorAll("#views button").forEach((b) => b.classList.toggle("active", b.dataset.v === v));
  $("app").hidden = v !== "live"; $("hist").hidden = v !== "hist";
  try { sessionStorage.setItem(`dashView_${BOT}`, v); } catch { /* ohne Speicher */ }
  if (v === "hist") load();
}
document.querySelectorAll("#views button").forEach((b) => (b.onclick = () => setView(b.dataset.v)));

async function load() {
  try { const r = await call("tradeHistory"); trades = r.trades; tfName = r.timeframe; } catch (e) { $("hsum").replaceChildren(h("div", { class: "error" }, `Fehler: ${e.message}`)); return; }
  loaded = true;
  const want = new URLSearchParams(location.search).get("trade");
  if (!sel || !trades.find((t) => t.id === sel.id)) sel = trades.find((t) => t.id === want) || visible()[0] || null;
  renderAll();
  if (sel) pick(sel);
}
const visible = () => trades.filter((t) => (filter === "all" || (filter === "win" ? t.pnl > 0 : t.pnl <= 0)) && (market === "all" || t.symbol === market));

function renderAll() {
  const list = visible(), n = trades.length, wins = trades.filter((t) => t.pnl > 0).length, sum = trades.reduce((x, t) => x + (t.pnl || 0), 0), fees = trades.reduce((x, t) => x + (t.fees || 0), 0);
  const tile = (k, v, cls = "") => h("div", { class: "tile" }, h("small", {}, k), h("strong", { class: cls }, v));
  $("hsum").replaceChildren(tile("Trades", String(n)), tile("Trefferquote", n ? `${Math.round((wins / n) * 100)} %` : "–"), tile("Ergebnis netto", n ? `${sg(sum)} USD` : "–", sum >= 0 ? "ok" : "bad"), tile("Gebühren", `${fmt(fees)} USD`));
  const markets = [...new Set(trades.map((t) => t.symbol))];
  const chip = (label, active, on) => h("button", { class: `chip${active ? " on" : ""}`, onclick: on }, label);
  $("hfilter").replaceChildren(chip("Alle", filter === "all", () => { filter = "all"; renderAll(); }), chip("Gewinne", filter === "win", () => { filter = "win"; renderAll(); }), chip("Verluste", filter === "loss", () => { filter = "loss"; renderAll(); }),
    markets.length > 1 && h("select", { onchange: (e) => { market = e.target.value; renderAll(); } }, h("option", { value: "all" }, "alle Märkte"), ...markets.map((m) => h("option", { value: m, selected: m === market }, m))));
  $("hlist").replaceChildren(...(list.length ? list.map((t) => {
    const up = t.pnl >= 0, pct = (t.exitPrice / t.entryPrice - 1) * 100;
    return h("div", { class: `titem ${up ? "up" : "down"}${sel?.id === t.id ? " sel" : ""}`, onclick: () => pick(t) },
      h("div", { class: "l1" }, h("b", {}, `${up ? "🟢" : "🔴"} ${t.symbol}`), h("span", { class: up ? "ok" : "bad" }, `${sg(t.pnl)} USD · ${pc(pct)}`)),
      h("div", { class: "l2" }, `${strategyLabel(t.strategy)} · ${t.kind} · ${hhmm(t.exitTs)}`));
  }) : [h("p", { class: "muted pad" }, n ? "Keine Trades mit diesem Filter." : "Noch keine abgeschlossenen Trades. Sobald der Bot einen Kauf wieder verkauft hat, erscheint er hier.")]));
  if (!list.length) { $("hhead").replaceChildren(); $("hdet").replaceChildren(); draw(); }
}

async function pick(t) {
  sel = t; cdl = null; hover = null;
  document.querySelectorAll(".titem").forEach((e) => e.classList.remove("sel"));
  renderAll();
  renderDetail(); draw();
  try { cdl = await call("tradeCandles", { symbol: t.symbol, from: t.entryTs, to: t.exitTs }); } catch { cdl = { t: [] }; }
  if (sel?.id === t.id) draw();
}

function renderDetail() {
  const t = sel; if (!t) return;
  const up = t.pnl >= 0, pct = (t.exitPrice / t.entryPrice - 1) * 100, ms = Date.parse(t.exitTs) - Date.parse(t.entryTs);
  $("hhead").replaceChildren(h("div", {}, h("div", { class: "muted" }, `${strategyLabel(t.strategy)} · ${stamp(t.entryTs)} → ${stamp(t.exitTs)} · ${dur(ms)}`), h("div", { class: "price" }, t.symbol)),
    h("div", { class: `pnl ${up ? "ok" : "bad"}` }, `${sg(t.pnl)} USD (${pc(pct)})`, h("span", { class: `kind k-${t.kind === "Stop-Loss" ? "bad" : t.kind === "Ziel erreicht" ? "ok" : "mid"}` }, t.kind)));
  const tile = (k, v, sub) => h("div", { class: "tile" }, h("small", {}, k), h("strong", {}, v), sub && h("div", { class: "muted sm" }, sub));
  const stops = levelSteps(t, "stop"), tps = levelSteps(t, "tp"), adj = (t.adj || []).slice(-8);
  $("hdet").replaceChildren(h("div", { class: "tiles" },
    tile("Einstieg", fmt(t.entryPrice), `Menge ${fmt(t.amount, 5)}`), tile("Ausstieg", fmt(t.exitPrice), t.kind),
    tile("Stop-Loss", stops.length ? fmt(stops.at(-1).price) : "–", stops.length > 1 ? `Start ${fmt(stops[0].price)} · ${stops.length - 1}× verschoben` : stops.length ? "nicht verschoben" : "nicht erfasst"),
    tile("Ziel", tps.length ? fmt(tps.at(-1).price) : "–", tps.length > 1 ? `Start ${fmt(tps[0].price)} · ${tps.length - 1}× verschoben` : tps.length ? "nicht verschoben" : "nicht erfasst"),
    tile("Gebühren", `${fmt(t.fees)} USD`, `Phase: ${{ uptrend: "Aufwärts", downtrend: "Abwärts", sideways: "Seitwärts" }[t.regime] ?? "–"}`)),
    adj.length ? h("div", { class: "chips" }, ...adj.map((a) => h("span", { class: "pill2" }, `${new Date(a.ts).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })} ${a.kind === "stop" ? "Stop" : "Ziel"} ${fmt(a.from)} → ${fmt(a.to)} (${a.by})`))) : null,
    h("div", { class: "muted sm" }, String(t.reason || "").slice(0, 160)));
  $("hlegend").replaceChildren(h("span", {}, h("i", { style: "background:#9aa3ae" }), "Einstieg"), h("span", {}, h("i", { style: "background:#ef6b5c" }), "Stop-Loss"), h("span", {}, h("i", { style: "background:#4cc26a" }), "Ziel"), h("span", {}, "▲ Kauf  ▼ Verkauf  ● verschoben"));
}

function draw() {
  const cv = $("hchart"), dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext("2d"); g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
  g.font = "11px system-ui"; g.textBaseline = "middle";
  const up = css("--ok"), dn = css("--bad"), fg = css("--muted"), line = css("--line");
  if (!sel) { g.fillStyle = fg; g.fillText("Trade links auswählen", 16, 24); return; }
  const t = sel, t0 = Date.parse(t.entryTs), t1 = Date.parse(t.exitTs), c = cdl && cdl.t.length ? cdl : null;
  const span = Math.max(t1 - t0, 60000), a = c ? c.t[0] : t0 - span * 0.15, b = c ? c.t.at(-1) + c.tfMs : t1 + span * 0.15;
  const stops = levelSteps(t, "stop"), tps = levelSteps(t, "tp");
  let lo = Math.min(t.entryPrice, t.exitPrice, ...stops.map((p) => p.price), ...(c ? c.low : [])), hi = Math.max(t.entryPrice, t.exitPrice, ...tps.map((p) => p.price), ...(c ? c.high : []));
  const m = (hi - lo) * 0.06 || hi * 0.002; lo -= m; hi += m;
  const padL = 8, padR = 74, padT = 14, padB = 24, X = (ts) => padL + ((ts - a) / (b - a)) * (W - padL - padR), Y = (p) => padT + (1 - (p - lo) / (hi - lo)) * (H - padT - padB);
  for (let k = 0; k <= 4; k++) { const p = lo + ((hi - lo) * k) / 4, y = Y(p); g.strokeStyle = line; g.beginPath(); g.moveTo(padL, y); g.lineTo(W - padR, y); g.stroke(); g.fillStyle = fg; g.fillText(fmt(p), W - padR + 6, y); }
  for (let k = 0; k <= 4; k++) { const ts = a + ((b - a) * k) / 4; g.fillStyle = fg; g.textAlign = k === 0 ? "left" : k === 4 ? "right" : "center"; g.fillText(hhmm(ts), Math.min(W - padR, Math.max(padL, X(ts))), H - 10); } g.textAlign = "left";
  g.fillStyle = t.pnl >= 0 ? "rgba(76,194,106,.08)" : "rgba(239,107,92,.08)"; g.fillRect(X(t0), padT, X(t1) - X(t0), H - padT - padB);   // Haltedauer
  if (c) {   // Kerzen
    const cw = Math.max(1, ((W - padL - padR) / (b - a)) * c.tfMs * 0.7);
    c.t.forEach((ts, i) => { const col = c.close[i] >= c.open[i] ? up : dn, x = X(ts + c.tfMs / 2); g.strokeStyle = col; g.fillStyle = col; g.beginPath(); g.moveTo(x, Y(c.high[i])); g.lineTo(x, Y(c.low[i])); g.stroke();
      const y1 = Y(c.open[i]), y2 = Y(c.close[i]); g.fillRect(x - cw / 2, Math.min(y1, y2), cw, Math.max(1, Math.abs(y2 - y1))); });
  } else { g.fillStyle = fg; g.fillText(cdl ? "Kerzen dieses Zeitraums sind nicht mehr abrufbar – Linien und Marken bleiben." : "lädt …", padL + 8, padT + 10); }
  g.strokeStyle = "#9aa3ae"; g.setLineDash([5, 4]); g.beginPath(); g.moveTo(X(t0), Y(t.entryPrice)); g.lineTo(X(t1), Y(t.entryPrice)); g.stroke(); g.setLineDash([]);
  const steps = (pts, col, label) => {
    if (!pts.length) return; g.strokeStyle = col; g.lineWidth = 2; g.beginPath(); g.moveTo(X(pts[0].ts), Y(pts[0].price));
    pts.slice(1).forEach((p) => { g.lineTo(X(p.ts), Y(pts[pts.indexOf(p) - 1].price)); g.lineTo(X(p.ts), Y(p.price)); });
    g.lineTo(X(t1), Y(pts.at(-1).price)); g.stroke(); g.lineWidth = 1; g.fillStyle = col;
    pts.slice(1).forEach((p) => { g.beginPath(); g.arc(X(p.ts), Y(p.price), 3.5, 0, 7); g.fill(); });
    g.fillText(`${label} ${fmt(pts.at(-1).price)}`, W - padR + 6, Y(pts.at(-1).price) + (label === "Stop" ? 12 : -12));
  };
  steps(stops, "#ef6b5c", "Stop"); steps(tps, "#4cc26a", "Ziel");
  const tri = (x, y, upw, col) => { g.fillStyle = col; g.beginPath(); if (upw) { g.moveTo(x, y - 9); g.lineTo(x - 7, y + 4); g.lineTo(x + 7, y + 4); } else { g.moveTo(x, y + 9); g.lineTo(x - 7, y - 4); g.lineTo(x + 7, y - 4); } g.fill(); };
  tri(X(t0), Y(t.entryPrice) + 14, true, up); tri(X(t1), Y(t.exitPrice) - 14, false, t.pnl >= 0 ? up : dn);
  g.fillStyle = fg; g.fillText(fmt(t.entryPrice), Math.min(X(t0) + 10, W - padR - 60), Y(t.entryPrice) + 14); g.textAlign = "right"; g.fillText(fmt(t.exitPrice), Math.max(X(t1) - 10, 70), Y(t.exitPrice) - 14); g.textAlign = "left";
  if (hover && c) {
    const i = c.t.findIndex((ts) => hover.x <= X(ts + c.tfMs)); if (i >= 0) { const tip = $("htip"); tip.hidden = false; tip.textContent = `${hhmm(c.t[i])}\nO ${fmt(c.open[i])}  H ${fmt(c.high[i])}\nL ${fmt(c.low[i])}  C ${fmt(c.close[i])}`; tip.style.left = `${Math.min(hover.x + 14, W - 170)}px`; tip.style.top = `${Math.max(4, hover.y - 60)}px`; }
  } else $("htip").hidden = true;
}
$("hchart").addEventListener("mousemove", (e) => { const r = e.target.getBoundingClientRect(); hover = { x: e.clientX - r.left, y: e.clientY - r.top }; draw(); });
$("hchart").addEventListener("mouseleave", () => { hover = null; draw(); });
addEventListener("resize", () => { if (!$("hist").hidden) draw(); });

const params = new URLSearchParams(location.search);
let start = params.get("tab") === "trades" ? "hist" : null;
try { start ||= sessionStorage.getItem(`dashView_${BOT}`); } catch { /* egal */ }
setView(start === "hist" ? "hist" : "live");
setInterval(() => { if (!$("hist").hidden && loaded) call("tradeHistory").then((r) => { if (r.trades.length !== trades.length) load(); }).catch(() => {}); }, 15000);
