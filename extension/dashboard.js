// Dashboard: Kerzenchart mit Trend (EMA 20/50), Einstieg/Stop/Ziel der offenen Position, Live-Gewinn und Signal-Matrix.
const BOT = new URLSearchParams(location.search).get("bot") || "crypto";
const call = async (type, extra = {}) => { const r = await chrome.runtime.sendMessage({ type, bot: BOT, ...extra }); if (!r?.ok) throw new Error(r?.error); return r.result; };
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
// Zoom/Verschieben des Charts: vis = sichtbare Kerzen, off = um so viele Kerzen nach links verschoben (0 = aktuell)
let vis = 160, off = 0, drag = null;
const MIN_VIS = 20, LOAD = 600;
const clampView = () => { const n = data ? data.t.length : LOAD; vis = Math.round(Math.min(Math.max(vis, MIN_VIS), n)); off = Math.round(Math.min(Math.max(off, 0), Math.max(0, n - vis))); };
const zoom = (factor, anchor = 1) => {   // anchor 0..1: Stelle im Chart, die beim Zoomen stehen bleibt (1 = rechter Rand/aktuell)
  const n = data.t.length, oldVis = vis, oldStart = n - vis - off, focus = oldStart + anchor * oldVis;
  vis = oldVis * factor; clampView();
  off = n - vis - (focus - anchor * vis); clampView(); draw();
};

async function refresh() {
  try {
    data = await call("chart", { symbol: selected, bars: LOAD });
    clampView();
    selected = data.symbol;
    if (document.activeElement?.matches?.("#panels input")) return draw();   // beim Tippen nicht die Eingabefelder neu aufbauen
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
    h("span", {}, "▲ Kauf  ▼ Verkauf"),
    h("span", { class: "zoom" }, h("button", { class: "btn", title: "Hineinzoomen (Mausrad)", onclick: () => zoom(0.7) }, "＋"), h("button", { class: "btn", title: "Herauszoomen (Mausrad)", onclick: () => zoom(1.4) }, "－"),
      h("button", { class: "btn", title: "Zurück zur Standardansicht (Doppelklick)", onclick: () => { vis = 160; off = 0; clampView(); draw(); } }, "↺"),
      h("span", { class: "muted", id: "zoomlbl" }, `${vis} Kerzen${off ? ` · ${off} zurück` : ""}`)));
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
  panels.unshift(tradePanel(pos, price));
  panels.push(h("div", { class: "card" }, h("h3", {}, `Signal-Matrix · ${selected}`),
    (a.checks || []).length ? h("table", {}, h("tr", {}, h("th", {}, "Strategie"), h("th", {}, "passt zur Phase"), h("th", {}, "Einstiegssignal")),
      ...a.checks.map((c) => h("tr", {}, h("td", {}, c.name), h("td", {}, c.fits ? "ja" : "nein"), h("td", { class: `sig ${c.signal ? "y" : "n"}` }, c.signal ? "JA" : "nein"))))
      : h("p", { class: "muted" }, "Keine aktive Strategie für diesen Markt. Im Popup „Strategien neu prüfen“ drücken."),
    h("div", { class: "hint" }, `Gewählt: ${a.strategy || "keine"} · geprüft bei jeder neuen Kerze (${data.timeframe}); nächste ca. ${a.nextCandleAt ? new Date(a.nextCandleAt).toLocaleTimeString("de-DE") : "–"}`)));
  panels.push(h("div", { class: "card" }, h("h3", {}, "Letzte Entscheidungen"),
    data.decisions.length ? h("table", {}, ...data.decisions.map((d) => h("tr", {}, h("td", { class: "muted" }, new Date(d.ts).toLocaleTimeString("de-DE")), h("td", {}, d.text.replace(/^.*? · /, "")))))
      : h("p", { class: "muted" }, "Noch keine geprüfte Kerze."),
    h("div", { class: "hint" }, `Positionen ${Object.keys(positions).length}/${data.maxPositions}${data.cash != null ? ` · Paper-Kasse ${fmt(data.cash)} USD` : ""}`)));
  panels.push(tradesCard());
  $("panels").replaceChildren(...panels);
  draw();
}
// ---- Handeln: kaufen, verkaufen, Stop-Loss/Take-Profit verschieben, KI-Trailing ----
const form = { usd: "", stop: "", tp: "", pstop: "", ptp: "" };
const field = (label, key, placeholder, step = "any") => h("label", { class: "fld" }, label,
  h("input", { type: "number", step, placeholder, value: form[key], oninput: (e) => { form[key] = e.target.value; } }));
async function doAct(fn, ok) {
  try { const r = await fn(); alert(typeof r === "string" ? r : ok); } catch (e) { alert(e.message); }
  form.pstop = form.ptp = ""; refresh();
}

function tradePanel(pos, price) {
  const t = data.trail, c = data.costs, fx = (x) => (x == null ? "" : String(Number(x.toPrecision(7))));
  if (!pos) {
    return h("div", { class: "card" }, h("h3", {}, `Handeln · ${selected}`),
      data.manualBuy ? h("div", {}, h("div", { class: "form2" }, field("Betrag (USD)", "usd", "leer = nach Risikoregel"), field("Stop-Loss (Kurs)", "stop", "leer = 2×ATR unter Kurs"), field("Take-Profit (Kurs)", "tp", "leer = Regel")),
        h("div", { class: "btns" }, h("button", { class: "btn primary", onclick: () => {
          if (!confirm(`${selected} jetzt zum Marktpreis ${fmt(price)} kaufen (Paper, Spielgeld)?`)) return;
          doAct(() => call("buy", { symbol: selected, usd: form.usd, stop: form.stop, takeProfit: form.tp }), "Gekauft."); } }, "🟢 Kaufen")),
        h("div", { class: "hint" }, `Gebühren und Rutschen werden eingerechnet (je Order ${(c.feePct + c.slippagePct).toFixed(2)} %). Harte Grenzen: höchstens 2 % Risiko, ${data.maxPositionPct} % des Kapitals je Position, Positionslimit.`))
        : h("p", { class: "muted" }, "Manueller Kauf gibt es nur im Paper-Modus."));
  }
  const unit = price - pos.entryPrice, profit = unit * pos.amount, costFrac = (2 * (c.feePct + c.slippagePct)) / 100;
  const set = (stop) => () => doAct(() => call("adjust", { symbol: selected, stop }), "Stop-Loss gesetzt.");
  return h("div", { class: "card" }, h("h3", {}, `Handeln · ${selected}`),
    h("div", { class: "row" }, h("span", { class: "muted" }, "Gewinn jetzt (vor Gebühren)"), h("span", { class: profit >= 0 ? "ok" : "bad" }, `${sign(profit)} USD`)),
    h("div", { class: "btns" }, h("button", { class: "btn danger", onclick: () => {
      if (!confirm(`${selected} jetzt zum Marktpreis ${fmt(price)} verkaufen? Ergebnis ca. ${sign(profit)} USD vor Gebühren.`)) return;
      doAct(() => call("sell", { symbol: selected }), "Verkauft."); } }, "🔴 Jetzt verkaufen")),
    h("div", { class: "form2" }, field(`Stop-Loss (jetzt ${fmt(pos.stop)})`, "pstop", fx(pos.stop)), field(`Take-Profit (jetzt ${fmt(pos.takeProfit)})`, "ptp", fx(pos.takeProfit))),
    h("div", { class: "btns" },
      h("button", { class: "btn", onclick: () => doAct(() => call("adjust", { symbol: selected, stop: form.pstop, takeProfit: form.ptp }), "Gesetzt.") }, "Stop/Ziel setzen"),
      unit > 0 && h("button", { class: "btn", title: "Stop auf Einstand plus Kosten – ein Ausstoppen kostet dann nichts", onclick: set(pos.entryPrice * (1 + costFrac)) }, "Stop → Einstand"),
      unit > 0 && h("button", { class: "btn", onclick: set(pos.entryPrice + unit * 0.5) }, "Stop sichert 50 %"),
      unit > 0 && h("button", { class: "btn", onclick: set(pos.entryPrice + unit * 0.75) }, "Stop sichert 75 %")),
    h("label", { class: "fld chk" }, h("input", { type: "checkbox", checked: !pos.trailOff && t.enabled, disabled: !t.enabled, onchange: (e) => doAct(() => call("adjust", { symbol: selected, trailOff: !e.target.checked }), "Gesetzt.") }),
      ` KI-Trailing für diese Position${t.enabled ? "" : " (in den Einstellungen ausgeschaltet)"}`),
    h("div", { class: "hint" }, `KI-Trailing: ab ${t.startUsd} USD Gewinn oder ${t.startR}×Risiko zieht der Bot den Stop-Loss nach (Basis: ${Math.round(t.lockFraction * 100)} % des Gewinns sichern, z. B. bei +${t.startUsd} → Stop bei +${(t.startUsd * t.lockFraction).toFixed(0)}); je nach Marktphase mehr (Seitwärts/Abwärts) oder weniger (starker Aufwärtstrend). Bei starkem Trend nahe am Ziel hebt er auch das Ziel an. Nie unter Einstand + Kosten, nie näher als 0,5 ATR am Kurs, nur nach oben.`),
    (pos.history || []).length ? h("div", { class: "decisions" }, h("strong", {}, "Verlauf der Anpassungen:"), ...pos.history.slice(-8).reverse().map((e) =>
      h("div", {}, h("span", { class: "muted" }, new Date(e.ts).toLocaleTimeString("de-DE") + " "), `${e.by}: ${e.kind === "stop" ? "Stop-Loss" : "Take-Profit"} ${fmt(e.from)} → ${fmt(e.to)}${e.why ? " – " + e.why : ""}`))) : null);
}

function tradesCard() {
  const rows = (data.trades || []).filter((tr) => tr.action !== "STOP").slice(-12).reverse();
  return h("div", { class: "card" }, h("h3", {}, `Käufe & Verkäufe · ${selected}`),
    rows.length ? h("table", {}, h("tr", {}, ...["Zeit", "", "Preis", "Menge", "Ergebnis (netto)"].map((x) => h("th", {}, x))),
      ...rows.map((tr) => h("tr", {}, h("td", { class: "muted" }, new Date(tr.ts).toLocaleString("de-DE")), h("td", { class: tr.action === "ENTRY" ? "ok" : "bad" }, tr.action === "ENTRY" ? "Kauf" : "Verkauf"),
        h("td", {}, fmt(tr.price)), h("td", {}, fmt(tr.amount, 5)), h("td", { class: tr.pnl == null ? "" : tr.pnl >= 0 ? "ok" : "bad" }, tr.pnl == null ? "–" : `${sign(tr.pnl)} USD`))))
      : h("p", { class: "muted" }, "Noch keine Trades in diesem Markt."));
}
const row = (k, v, cls = "") => h("div", { class: "row" }, h("span", { class: "muted" }, k), h("span", { class: cls }, v));

// ---- Kerzenchart (Canvas, ohne Fremdbibliothek) ----
function draw() {
  const cv = $("chart"), dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext("2d"); g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
  if (!data) return;
  const lbl = $("zoomlbl"); if (lbl) lbl.textContent = `${vis} Kerzen${off ? ` · ${off} zurück` : ""}`;
  const N = data.t.length, e = N - off, b = Math.max(0, e - vis), sl = (a) => a.slice(b, e);
  const t = sl(data.t), open = sl(data.open), high = sl(data.high), low = sl(data.low), close = sl(data.close), ema20 = sl(data.ema20), ema50 = sl(data.ema50), pos = data.position, n = t.length;
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
$("chart").addEventListener("mousemove", (e) => {
  const r = e.target.getBoundingClientRect(); hover = { x: e.clientX - r.left, y: e.clientY - r.top };
  if (drag && data) { const cw = (r.width - 78) / vis; off = drag.off + Math.round((e.clientX - drag.x) / cw); clampView(); }   // mit gedrückter Maustaste verschieben
  draw();
});
$("chart").addEventListener("mousedown", (e) => { drag = { x: e.clientX, off }; e.target.style.cursor = "grabbing"; });
addEventListener("mouseup", () => { drag = null; $("chart").style.cursor = "crosshair"; });
$("chart").addEventListener("dblclick", () => { vis = 160; off = 0; clampView(); draw(); });
$("chart").addEventListener("wheel", (e) => {   // Mausrad: hinein-/herauszoomen an der Mausposition
  if (!data) return;
  e.preventDefault();
  const r = e.target.getBoundingClientRect(), anchor = Math.min(1, Math.max(0, (e.clientX - r.left - 8) / (r.width - 78)));
  zoom(e.deltaY < 0 ? 0.8 : 1.25, anchor);
}, { passive: false });
$("chart").addEventListener("mouseleave", () => { hover = null; draw(); });
addEventListener("resize", draw);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", draw);

selected = new URLSearchParams(location.search).get("symbol");
refresh();
setInterval(refresh, 10_000);
