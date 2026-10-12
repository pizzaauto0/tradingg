// Dashboard: Kerzenchart mit Trend (EMA 20/50), Einstieg/Stop/Ziel der offenen Position, Live-Gewinn und Signal-Matrix.
const call = async (type, extra = {}) => { const r = await chrome.runtime.sendMessage({ type, ...extra }); if (!r?.ok) throw new Error(r?.error); return r.result; };
const $ = (id) => document.getElementById(id);
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v); }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return e;
}
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const fmt = (x, d = 2) => (x == null || !isFinite(x) ? "–" : x >= 1000 ? x.toLocaleString("de-DE", { maximumFractionDigits: d }) : x.toFixed(x < 1 ? 5 : d));
const sign = (x) => (x >= 0 ? "+" : "") + fmt(x);
const regimeBadge = (r) => h("span", { class: `badge ${r === "uptrend" ? "up" : r === "downtrend" ? "down" : r ? "side" : ""}` },
  r === "uptrend" ? "Aufwärts" : r === "downtrend" ? "Abwärts" : r === "sideways" ? "Seitwärts" : "–");

let selected = null, data = null, hover = null;

async function refresh() {
  try {
    data = await call("chart", { symbol: selected, bars: 160 });
    selected = data.symbol;
    render();
  } catch (e) { $("head").replaceChildren(h("div", { class: "error" }, `Fehler: ${e.message}`)); }
}

function render() {
  const { activity, positions, symbols } = data, pos = data.position, price = data.close.at(-1);
  // Märkte links
  $("markets").replaceChildren(...symbols.map((s) => {
    const a = activity[s] || {}, p = positions[s];
    const pnl = p && a.price ? (a.price - p.entryPrice) * p.amount : null;
    return h("div", { class: `mk${s === selected ? " sel" : ""}`, onclick: () => { selected = s; refresh(); } },
      h("div", { class: "t" }, h("span", {}, s), regimeBadge(a.regime)),
      h("div", { class: "s" }, h("span", {}, a.error ? "Fehler" : fmt(a.price)), p ? h("span", { class: pnl >= 0 ? "ok" : "bad" }, `Position ${sign(pnl)}`) : h("span", {}, "keine Position")));
  }));
  // Kopf
  const a = activity[selected] || {};
  const pnl = pos ? (price - pos.entryPrice) * pos.amount : null;
  $("head").replaceChildren(
    h("div", {}, h("div", { class: "muted" }, `${selected} · ${data.timeframe} · ${data.paper ? "Paper (Spielgeld)" : "LIVE"} · Bot ${data.enabled ? "läuft" : "gestoppt"}`),
      h("div", { class: "price" }, fmt(price), " ", regimeBadge(a.regime))),
    pos ? h("div", { class: `pnl ${pnl >= 0 ? "ok" : "bad"}` }, `Offene Position: ${sign(pnl)} USD (${sign(((price / pos.entryPrice) - 1) * 100)} %)`)
        : h("div", { class: "muted" }, "Keine offene Position – der Bot wartet auf ein Signal"));
  $("legend").replaceChildren(
    h("span", {}, h("i", { style: "background:#4c8dff" }), "EMA 20 (kurzer Trend)"), h("span", {}, h("i", { style: "background:#e0a23a" }), "EMA 50 (längerer Trend)"),
    pos && h("span", {}, h("i", { style: "background:#9aa3ae" }), "Einstieg"), pos && h("span", {}, h("i", { style: "background:#ef6b5c" }), "Stop-Loss"), pos && h("span", {}, h("i", { style: "background:#4cc26a" }), "Ziel"),
    h("span", {}, "▲ Kauf  ▼ Verkauf"));
  // Panels
  const panels = [];
  if (pos) {
    const span = pos.takeProfit - pos.stop, at = Math.min(1, Math.max(0, (price - pos.stop) / span));
    const risk = (pos.entryPrice - pos.stop) * pos.amount, reward = (pos.takeProfit - pos.entryPrice) * pos.amount;
    panels.push(h("div", { class: "card" }, h("h3", {}, "Offene Position"),
      row("Strategie", pos.strategyName), row("Marktphase beim Einstieg", pos.regime), row("Eingestiegen", new Date(pos.openedAt).toLocaleString("de-DE")),
      row("Einstieg / Menge", `${fmt(pos.entryPrice)} · ${pos.amount}`), row("Stop-Loss", fmt(pos.stop), "bad"), row("Ziel", fmt(pos.takeProfit), "ok"),
      row("Risiko / Chance", `${fmt(risk)} / ${fmt(reward)} USD`),
      h("div", { class: "bar" }, h("b", { style: `left:${(at * 100).toFixed(1)}%` })),
      h("div", { class: "row muted" }, h("span", {}, "Stop"), h("span", {}, `Kurs ${fmt(price)}`), h("span", {}, "Ziel")),
      h("div", { class: "hint" }, pos.reason)));
  }
  panels.push(h("div", { class: "card" }, h("h3", {}, `Signal-Matrix · ${selected}`),
    (a.checks || []).length ? h("table", {}, h("tr", {}, h("th", {}, "Strategie"), h("th", {}, "passt zur Phase"), h("th", {}, "Einstiegssignal")),
      ...a.checks.map((c) => h("tr", {}, h("td", {}, c.name), h("td", {}, c.fits ? "ja" : "nein"), h("td", { class: `sig ${c.signal ? "y" : "n"}` }, c.signal ? "JA" : "nein"))))
      : h("p", { class: "muted" }, "Keine aktive Strategie für diesen Markt. Im Popup „Strategien neu prüfen“ drücken."),
    h("div", { class: "hint" }, `Gewählt: ${a.strategy || "keine"} · geprüft bei jeder neuen Kerze (${data.timeframe}); nächste ca. ${a.nextCandleAt ? new Date(a.nextCandleAt).toLocaleTimeString("de-DE") : "–"}`)));
  panels.push(h("div", { class: "card" }, h("h3", {}, "Letzte Entscheidungen"),
    data.decisions.length ? h("table", {}, ...data.decisions.map((d) => h("tr", {}, h("td", { class: "muted" }, new Date(d.ts).toLocaleTimeString("de-DE")), h("td", {}, d.text.replace(/^.*? · /, "")))))
      : h("p", { class: "muted" }, "Noch keine geprüfte Kerze."),
    h("div", { class: "hint" }, `Positionen ${Object.keys(positions).length}/${data.maxPositions}${data.cash != null ? ` · Paper-Kasse ${fmt(data.cash)} USD` : ""}`)));
  $("panels").replaceChildren(...panels);
  draw();
}
const row = (k, v, cls = "") => h("div", { class: "row" }, h("span", { class: "muted" }, k), h("span", { class: cls }, v));

// ---- Kerzenchart (Canvas, ohne Fremdbibliothek) ----
function draw() {
  const cv = $("chart"), dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext("2d"); g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
  if (!data) return;
  const { t, open, high, low, close, ema20, ema50 } = data, pos = data.position, n = t.length;
  const padL = 8, padR = 70, padT = 12, padB = 24, cw = (W - padL - padR) / n;
  let lo = Math.min(...low), hi = Math.max(...high);
  if (pos) { lo = Math.min(lo, pos.stop); hi = Math.max(hi, pos.takeProfit); }
  const m = (hi - lo) * 0.05; lo -= m; hi += m;
  const X = (i) => padL + (i + 0.5) * cw, Y = (p) => padT + (1 - (p - lo) / (hi - lo)) * (H - padT - padB);
  const up = css("--ok"), dn = css("--bad"), fg = css("--muted"), line = css("--line");
  g.font = "11px system-ui"; g.textBaseline = "middle";
  for (let k = 0; k <= 5; k++) { const p = lo + ((hi - lo) * k) / 5, y = Y(p); g.strokeStyle = line; g.beginPath(); g.moveTo(padL, y); g.lineTo(W - padR, y); g.stroke(); g.fillStyle = fg; g.fillText(fmt(p), W - padR + 6, y); }
  const tf = data.timeframe, step = Math.ceil(n / 8);
  for (let i = 0; i < n; i += step) { const d = new Date(t[i]); g.fillStyle = fg; g.fillText(tf.endsWith("h") || tf.endsWith("m") ? d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString("de-DE"), X(i) - 16, H - 10); }
  if (pos) { // Zone zwischen Einstieg und aktuellem Kurs
    const y1 = Y(pos.entryPrice), y2 = Y(close[n - 1]);
    g.fillStyle = close[n - 1] >= pos.entryPrice ? "rgba(76,194,106,.12)" : "rgba(239,107,92,.12)"; g.fillRect(padL, Math.min(y1, y2), W - padL - padR, Math.abs(y2 - y1));
    for (const [p, c, label] of [[pos.entryPrice, "#9aa3ae", "Einstieg"], [pos.stop, "#ef6b5c", "Stop"], [pos.takeProfit, "#4cc26a", "Ziel"]]) {
      g.strokeStyle = c; g.setLineDash([6, 4]); g.beginPath(); g.moveTo(padL, Y(p)); g.lineTo(W - padR, Y(p)); g.stroke(); g.setLineDash([]);
      g.fillStyle = c; g.fillText(`${label} ${fmt(p)}`, W - padR - 110, Y(p) - 8);
    }
  }
  for (let i = 0; i < n; i++) { // Kerzen
    const c = close[i] >= open[i] ? up : dn;
    g.strokeStyle = c; g.fillStyle = c; g.beginPath(); g.moveTo(X(i), Y(high[i])); g.lineTo(X(i), Y(low[i])); g.stroke();
    const y1 = Y(open[i]), y2 = Y(close[i]); g.fillRect(X(i) - cw * 0.35, Math.min(y1, y2), cw * 0.7, Math.max(1, Math.abs(y2 - y1)));
  }
  for (const [arr, c] of [[ema20, "#4c8dff"], [ema50, "#e0a23a"]]) { // Trendlinien
    g.strokeStyle = c; g.lineWidth = 1.6; g.beginPath(); let started = false;
    arr.forEach((v, i) => { if (!isFinite(v)) return; if (!started) { g.moveTo(X(i), Y(v)); started = true; } else g.lineTo(X(i), Y(v)); });
    g.stroke(); g.lineWidth = 1;
  }
  const tfMs = n > 1 ? t[1] - t[0] : 60000;
  for (const tr of data.trades) { // Kauf-/Verkaufsmarken
    const i = Math.floor((Date.parse(tr.ts) - t[0]) / tfMs); if (i < 0 || i >= n) continue;
    const buy = tr.action === "ENTRY"; g.fillStyle = buy ? up : dn; const x = X(i), y = buy ? Y(low[i]) + 12 : Y(high[i]) - 12;
    g.beginPath(); if (buy) { g.moveTo(x, y - 8); g.lineTo(x - 6, y + 4); g.lineTo(x + 6, y + 4); } else { g.moveTo(x, y + 8); g.lineTo(x - 6, y - 4); g.lineTo(x + 6, y - 4); } g.fill();
  }
  const y = Y(close[n - 1]); g.fillStyle = fg; g.fillRect(W - padR, y - 9, padR - 2, 18); g.fillStyle = css("--bg"); g.fillText(fmt(close[n - 1]), W - padR + 4, y); // aktueller Kurs
  if (hover != null) { // Fadenkreuz
    const i = Math.min(n - 1, Math.max(0, Math.floor((hover.x - padL) / cw)));
    g.strokeStyle = fg; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(X(i), padT); g.lineTo(X(i), H - padB); g.stroke(); g.setLineDash([]);
    const tip = $("tip"); tip.hidden = false;
    tip.textContent = `${new Date(t[i]).toLocaleString("de-DE")}\nO ${fmt(open[i])}  H ${fmt(high[i])}\nL ${fmt(low[i])}  C ${fmt(close[i])}\nEMA20 ${fmt(ema20[i])}  EMA50 ${fmt(ema50[i])}`;
    tip.style.left = `${Math.min(hover.x + 14, W - 190)}px`; tip.style.top = `${Math.max(4, hover.y - 70)}px`;
  } else $("tip").hidden = true;
}
$("chart").addEventListener("mousemove", (e) => { const r = e.target.getBoundingClientRect(); hover = { x: e.clientX - r.left, y: e.clientY - r.top }; draw(); });
$("chart").addEventListener("mouseleave", () => { hover = null; draw(); });
addEventListener("resize", draw);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", draw);

selected = new URLSearchParams(location.search).get("symbol");
refresh();
setInterval(refresh, 10_000);
