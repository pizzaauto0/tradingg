// Dashboard „Alle“: die drei Bots (Währungen, Silber & Gold, Krypto) mit ihrem HAUPT-Modus zusammengefasst; weitere Tabs zeigen je Bot das ausführliche Dashboard mit Chart.
import { ago, stamp, strategyLabel } from "./lib/names.js";
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const call = async (type, extra = {}) => { const r = await chrome.runtime.sendMessage({ type, ...extra }); if (!r?.ok) throw new Error(r?.error || "Keine Antwort"); return r.result; };
const sg = (x, d = 2) => (x == null || !Number.isFinite(x) ? "–" : `${x >= 0 ? "+" : ""}${x.toFixed(d)}`);
const px = (x) => (x == null ? "–" : x >= 100 ? x.toFixed(2) : x >= 1 ? x.toFixed(4) : x.toFixed(6));
const BOTS = [["fx", "Währungen"], ["metals", "Silber & Gold"], ["crypto", "Krypto"]];
const REGIME = { uptrend: "Aufwärts", downtrend: "Abwärts", sideways: "Seitwärts" };
let active = "all";
try { const t = localStorage.getItem("alldashTab"); if (t === "all" || BOTS.some(([b]) => b === t)) active = t; } catch { /* ohne Speicher */ }

function select(id) {
  active = id;
  try { localStorage.setItem("alldashTab", id); } catch { /* egal */ }
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.t === id));
  $("all").hidden = id !== "all"; $("frames").hidden = id === "all";
  document.querySelectorAll("iframe").forEach((f) => f.classList.toggle("active", f.dataset.bot === id));
  if (id === "all") render();
}
for (const [id, label] of [["all", "📊 Alle"], ...BOTS]) {
  const b = el("button", null, label); b.dataset.t = id; b.onclick = () => select(id); $("tabs").append(b);
}
for (const [id] of BOTS) { const f = el("iframe"); f.dataset.bot = id; f.src = `dashboard.html?bot=${id}`; $("frames").append(f); }

let data = null;
const openPos = new Set();
const kpi = (label, value, sub, cls) => { const d = el("div", "k"); d.append(el("small", null, label), el("strong", cls || "", value)); if (sub) d.append(el("div", "sub", sub)); return d; };
const table = (head, rows, cls) => {
  const t = el("table"), hr = el("tr");
  head.forEach((h, i) => hr.append(el("th", i === 0 ? "l" : "", h))); t.append(hr);
  for (const r of rows) { const tr = el("tr"); r.forEach((c, i) => { const td = el("td", c?.cls || "", c?.text ?? c); if (c?.node) { td.textContent = ""; td.append(c.node); } tr.append(td); }); t.append(tr); }
  const w = el("div", "wrap"); w.append(t); return w;
};
const sec = (title, ...kids) => { const b = el("div", "box"); b.append(el("h3", null, title), ...kids); return b; };

async function render() {
  try { data = await call("getOverview"); } catch (e) { $("all").replaceChildren(el("div", "warn2", `Fehler: ${e.message}`)); return; }
  const d = data, P = d.periods, a = d.account, parts = [];
  if (d.breaker) parts.push(el("div", "warn2", `🛑 NOT-AUS-BREMSE ausgelöst (${new Date(d.breaker.ts).toLocaleString("de-DE")}): alle Positionen geschlossen, alle Bots gestoppt. „Alle starten“ in der App hebt sie auf.`));
  const g1 = el("div", "grid");
  g1.append(kpi("Eigenkapital (gemeinsames Konto)", `${a.equity.toFixed(2)} USD`, `Bargeld ${a.cash.toFixed(2)} · in Positionen ${a.held.toFixed(2)}`),
    kpi("Heute", `${sg(P.today.usd)} USD`, `${sg(P.today.pct)} % · realisiert ${sg(P.today.realized)}`, P.today.usd >= 0 ? "ok" : "bad"),
    kpi("Letzte 7 Tage", `${sg(P.week.usd)} USD`, `${sg(P.week.pct)} % · ${P.week.sells} Verkäufe`, P.week.usd >= 0 ? "ok" : "bad"),
    kpi("Insgesamt", `${sg(P.total.usd)} USD`, `${sg(P.total.pct)} % · Gebühren ${P.total.fees.toFixed(2)}`, P.total.usd >= 0 ? "ok" : "bad"));
  parts.push(g1);
  const g2 = el("div", "grid");
  for (const b of d.bots) {
    const c = el("div", "k"), dot = el("span", `dot ${b.lastError && b.enabled ? "bad" : b.enabled ? "on" : ""}`), head = el("small"); head.append(dot, document.createTextNode(b.label));
    const st = [b.enabled ? "läuft" : "gestoppt", b.paused ? "Kaufpause" : "", b.halted ? "Tageslimit" : "", b.live ? "LIVE" : ""].filter(Boolean).join(" · ");
    c.append(head, el("strong", null, `Modus: ${b.modeLabel}`), el("div", "sub", `${st} · ${b.timeframe} · ${b.activeStrategies} aktive Strategien`), el("div", "sub", `${b.positions.length} offen · heute ${sg(b.realizedToday)} · gesamt ${sg(b.realizedTotal)} USD`));
    c.style.cursor = "pointer"; c.onclick = () => select(b.id); g2.append(c);
  }
  parts.push(g2);

  const pos = d.bots.flatMap((b) => b.positions.map((p) => ({ ...p, bot: b })));
  const sell = (p) => { const bt = el("button", "btn", "Verkaufen"); bt.onclick = async (ev) => { ev.stopPropagation(); if (!confirm(`${p.symbol} jetzt zum Marktpreis verkaufen?`)) return; try { alert(await call("sell", { bot: p.bot.id, symbol: p.symbol })); } catch (e) { alert(e.message); } render(); }; return bt; };
  const posBox = el("div", "poslist");
  for (const p of pos) {
    const pnl = (p.price - p.entryPrice) * p.amount, up = pnl >= 0, key = `${p.bot.id}:${p.symbol}`;
    const row = el("div", `prow2 ${up ? "up" : "down"}`), top = el("div", "ptop2");
    top.append(el("b", null, `${up ? "🟢" : "🔴"} ${p.symbol}`), el("span", up ? "ok" : "bad", `${sg(pnl)} USD (${sg((p.price / p.entryPrice - 1) * 100)} %)`),
      el("span", "muted", `${p.bot.label} · ${strategyLabel(p.strategyName)} · geöffnet ${ago(p.openedAt)}`), sell(p));
    const det = el("div", "pdet2"); det.hidden = !openPos.has(key);
    det.append(el("div", null, `Geöffnet: ${p.openedAt ? stamp(p.openedAt) : "–"} (${ago(p.openedAt)})`), el("div", null, `Menge ${p.amount.toFixed(5)} · Einstieg ${px(p.entryPrice)} → jetzt ${px(p.price)}`),
      el("div", null, `Stop-Loss ${px(p.stop)} · Take-Profit ${px(p.takeProfit)}`), el("div", "muted", `Strategie: ${strategyLabel(p.strategyName)}`));
    row.onclick = () => { det.hidden = !det.hidden; det.hidden ? openPos.delete(key) : openPos.add(key); };
    row.append(top, det); posBox.append(row);
  }
  parts.push(sec(`Offene Positionen (${pos.length}) – zum Aufklappen anklicken`, pos.length ? posBox : el("div", "muted", "keine offene Position")));

  const mk = d.bots.flatMap((b) => b.markets.map((m) => ({ ...m, bot: b })));
  parts.push(sec(`Märkte (${mk.length})`, table(["Markt", "Bot", "Kurs", "Phase", "Strategie", "Signal"], mk.map((m) => [m.symbol, m.bot.label, m.error ? { text: "Daten nicht ladbar", cls: "bad" } : px(m.price), REGIME[m.regime] || "–",
    m.strategy ? strategyLabel(m.strategy) : { text: m.error ? "" : m.price == null ? "noch keine Daten" : "keine passende", cls: "muted" }, m.signal == null ? "–" : { text: m.signal ? "JA" : "nein", cls: m.signal ? "sig" : "" }]))));

  parts.push(sec("Letzte Käufe & Verkäufe (alle Bots)", d.trades.length ? table(["Zeit", "", "Markt", "Bot", "Preis", "Ergebnis netto", "Strategie"], d.trades.slice(0, 20).map((t) => [new Date(t.ts).toLocaleString("de-DE"),
    { text: t.action === "ENTRY" ? "Kauf" : "Verkauf", cls: t.action === "ENTRY" ? "ok" : "bad" }, t.symbol, d.bots.find((b) => b.id === (t.bot || "crypto"))?.label || "", px(t.price),
    t.pnl == null ? "–" : { text: `${sg(t.pnl)} USD`, cls: t.pnl >= 0 ? "ok" : "bad" }, strategyLabel(t.strategy || "")])) : el("div", "muted", "noch keine Trades")));

  const cv = el("canvas"); parts.push(sec("Eigenkapital-Verlauf (gemeinsames Konto)", cv));
  $("all").replaceChildren(...parts);
  draw(cv, d.curve, d.capital);
}

function draw(cv, pts, base) {
  const W = cv.clientWidth, H = cv.clientHeight, dpr = devicePixelRatio || 1;
  if (!W) return;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext("2d"); g.scale(dpr, dpr);
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  if (pts.length < 2) { g.fillStyle = css("--muted"); g.font = "12px system-ui"; g.fillText("Noch zu wenig Verlauf – alle 5 Minuten kommt ein Punkt dazu.", 8, 24); return; }
  const vals = pts.map((p) => p[1]).concat(base);
  let lo = Math.min(...vals), hi = Math.max(...vals); const m = Math.max((hi - lo) * 0.1, 0.5); lo -= m; hi += m;
  const padL = 52, X = (t) => padL + ((t - pts[0][0]) / Math.max(1, pts.at(-1)[0] - pts[0][0])) * (W - padL - 8), Y = (v) => 8 + (1 - (v - lo) / (hi - lo)) * (H - 24);
  g.font = "11px system-ui"; g.textBaseline = "middle";
  for (let k = 0; k <= 4; k++) { const v = lo + ((hi - lo) * k) / 4; g.strokeStyle = css("--line"); g.beginPath(); g.moveTo(padL, Y(v)); g.lineTo(W - 8, Y(v)); g.stroke(); g.fillStyle = css("--muted"); g.fillText(v.toFixed(2), 4, Y(v)); }
  g.setLineDash([5, 4]); g.strokeStyle = css("--muted"); g.beginPath(); g.moveTo(padL, Y(base)); g.lineTo(W - 8, Y(base)); g.stroke(); g.setLineDash([]);
  g.strokeStyle = pts.at(-1)[1] >= base ? css("--ok") : css("--bad"); g.lineWidth = 2; g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(X(p[0]), Y(p[1])) : g.moveTo(X(p[0]), Y(p[1])))); g.stroke();
  g.fillStyle = css("--muted"); const f = (t) => new Date(t).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); g.fillText(f(pts[0][0]), padL, H - 6); g.fillText(f(pts.at(-1)[0]), W - 100, H - 6);
}

select(active);
setInterval(() => { if (active === "all") render(); }, 5000);
addEventListener("resize", () => { if (active === "all" && data) render(); });
