// Rahmen der Desktop-App: gemeinsames Paper-Konto oben, darunter ein Tab je Bot (Währungen, Silber & Gold, Krypto).
// Jeder Tab ist die unveränderte Popup-Seite der Erweiterung mit ?bot=<id>.
import { ago, strategyLabel } from "./lib/names.js";
const BOTS = [["fx", "Währungen"], ["metals", "Silber & Gold"], ["crypto", "Krypto"]];
const TABS = [...BOTS, ["dash", "📊 Dashboard"], ["profit", "💰 Profit"], ["compare", "📊 Vergleich"]];
const MODES = [["strict", "Streng"], ["explore", "Erkunden"], ["playbook", "Playbook"], ["winrate", "Trefferquote"], ["final", "Final-3"]];
let modes = null;                 // Antwort von getModes (Vergleichstabelle), alle paar Sekunden aktualisiert
const subMode = {};               // gewählter Modus je Bot (Standard: der Haupt-Modus)
const mainOf = (bot) => modes?.rows.find((r) => r.bot === bot && r.main)?.mode ?? "strict";
const $ = (id) => document.getElementById(id);
const call = async (type, extra = {}) => { const r = await chrome.runtime.sendMessage({ type, ...extra }); if (!r?.ok) throw new Error(r?.error || "Keine Antwort vom Hintergrunddienst"); return r.result; };
const money = (x) => (x == null ? "–" : Number(x).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " USD");

let active = "fx";
try { const t = localStorage.getItem("botTab"); if (TABS.some(([id]) => id === t)) active = t; } catch { /* ohne Speicher: Standard-Tab */ }

function select(id) {
  active = id;
  try { localStorage.setItem("botTab", id); } catch { /* egal */ }
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.bot === id));
  document.querySelectorAll("iframe").forEach((f) => f.classList.toggle("active", f.dataset.bot === id));
  const isBot = BOTS.some(([b]) => b === id), sub = isBot ? (subMode[id] || mainOf(id)) : null, showFrame = isBot && sub === mainOf(id);
  $("frames").hidden = !showFrame; $("dashframe").hidden = id !== "dash"; if (id === "dash" && !$("dashframe").src) $("dashframe").src = "__alldash.html"; $("profit").hidden = id !== "profit"; $("compare").hidden = id !== "compare"; $("modeview").hidden = !(isBot && !showFrame); $("subtabs").hidden = !isBot;
  if (id === "profit") renderProfit();
  if (id === "compare") renderCompare();
  if (isBot) { renderSubtabs(id); if (!showFrame) renderMode(id, sub); }
}

for (const [id, label] of BOTS) {
  const b = document.createElement("button");
  b.dataset.bot = id; b.id = `tab-${id}`;
  b.innerHTML = '<span class="dot"></span><span class="lbl"></span>';
  b.querySelector(".lbl").textContent = label;
  b.onclick = () => select(id);
  $("tabs").append(b);
  const f = document.createElement("iframe");
  f.dataset.bot = id; f.src = `popup.html?bot=${id}`;
  $("frames").append(f);
}
{
  const b = document.createElement("button");
  b.dataset.bot = "profit"; b.id = "tab-profit"; b.textContent = "💰 Profit"; b.onclick = () => select("profit");
  const dsh = document.createElement("button");
  dsh.dataset.bot = "dash"; dsh.id = "tab-dash"; dsh.textContent = "📊 Dashboard"; dsh.onclick = () => select("dash");
  const c = document.createElement("button");
  c.dataset.bot = "compare"; c.id = "tab-compare"; c.textContent = "📊 Vergleich"; c.onclick = () => select("compare");
  $("tabs").append(dsh, b, c);
}

// ---- Modi: Unter-Tabs je Bot, Detailansicht eines Schatten-Modus, Vergleichstabelle ----
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const sgn = (x, d = 2) => (x == null || !Number.isFinite(x) ? "–" : `${x >= 0 ? "+" : ""}${x.toFixed(d)}`);
async function loadModes() { try { modes = await call("getModes"); } catch { /* Hintergrund noch nicht bereit */ } }
function renderSubtabs(bot) {
  const bar = $("subtabs"), main = mainOf(bot), cur = subMode[bot] || main;
  bar.replaceChildren(...MODES.map(([m, label]) => {
    const row = modes?.rows.find((r) => r.bot === bot && r.mode === m), b = el("button", `${m === cur ? "active" : ""} ${row?.off ? "off" : ""}`, `${m === main ? "★ " : ""}${label}${row && !row.off && !row.main ? ` ${sgn(row.profit, 1)}` : ""}`);
    b.title = m === main ? "Haupt-Modus: handelt mit dem gemeinsamen Paper-Konto (Einstellung im Tab „Strategien“)" : row?.off ? "ausgeschaltet (⚙ Einstellungen → Vergleichs-Modi)" : "Schatten-Lauf mit eigenem Paper-Geld – läuft im Hintergrund weiter";
    b.onclick = () => { subMode[bot] = m; select(bot); };
    return b;
  }));
}
function kpi(label, value, cls) { const d = el("div"), s = el("small", null, label), b = el("strong", cls || "", value); d.append(s, b); return d; }
async function renderMode(bot, mode) {
  const box = $("modeview");
  let d; try { d = await call("getModeDetail", { bot, mode }); } catch (e) { box.replaceChildren(el("div", "pbox", e.message)); return; }
  if ((subMode[bot] || mainOf(bot)) !== mode || $("modeview").hidden) return;   // inzwischen anderer Tab
  const s = d.summary, p = s.perf, parts = [];
  const head = el("div", "mvhead"), h2 = el("h2", null, `${d.botLabel} · Modus ${d.label}`);
  head.append(h2, el("span", "tag", d.main ? "Haupt-Modus · gemeinsames Paper-Konto" : "Schatten-Lauf · eigenes Paper-Geld"), el("span", "tag", d.lastTick ? `zuletzt geprüft ${new Date(d.lastTick).toLocaleTimeString("de-DE")}` : "noch nicht gelaufen"));
  if (d.lastError) head.append(el("div", "bad", `Letzter Fehler: ${d.lastError}`));
  parts.push(head);
  const grid = el("div", "perfgrid pbox");
  grid.append(kpi("Eigenkapital", `${d.equity.toFixed(2)} USD`), kpi("Gewinn gesamt", `${sgn(s.profit)} USD (${sgn(s.pct)} %)`, s.profit >= 0 ? "ok" : "bad"), kpi("realisiert / offen", `${sgn(s.realized)} / ${sgn(s.unrealized)} USD`),
    kpi("Abgeschlossene Trades", String(p.trades)), kpi("Trefferquote", p.winRate == null ? "–" : `${p.winRate.toFixed(0)} %`), kpi("Profitfaktor", p.profitFactor === Infinity ? "∞" : p.profitFactor == null ? "–" : p.profitFactor.toFixed(2)),
    kpi("Erwartungswert je Trade", p.expectancy == null ? "–" : `${sgn(p.expectancy)} USD`), kpi("Max. Drawdown", d.main ? "siehe Profit-Tab" : `${p.maxDrawdownPct.toFixed(1)} %`), kpi("Gebühren", `${s.fees.toFixed(2)} USD`), kpi("Strategien", `${d.active.length} aktiv / ${d.approved} zugelassen`));
  parts.push(grid);
  if (d.active.length) { const a = el("div", "pbox"); a.append(el("b", null, "Aktive Strategien: "), document.createTextNode(d.active.join(" · "))); parts.push(a); }
  const pos = el("div", "pbox"); pos.append(el("b", null, `Offene Positionen (${d.positions.length})`));
  const pt = el("table", "mvtable"); pt.append(...[["Markt", "Menge", "Einstieg", "Jetzt", "Ergebnis", "Stop", "Ziel", "Strategie", "Geöffnet"], ...d.positions.map((q) => [q.symbol, q.amount.toFixed(5), q.entryPrice, q.price, sgn((q.price - q.entryPrice) * q.amount), q.stop, q.takeProfit, strategyLabel(q.strategyName), q.openedAt ? ago(q.openedAt) : "–"])]
    .map((r, i) => { const tr = el("tr"); r.forEach((x, j) => { const td = el(i ? "td" : "th", i && j === 4 ? (Number(x) >= 0 ? "ok" : "bad") : "", typeof x === "number" ? (x >= 100 ? x.toFixed(2) : x.toFixed(4)) : x); tr.append(td); }); return tr; }));
  pos.append(d.positions.length ? pt : el("div", "muted", "keine offene Position")); parts.push(pos);
  const tr = el("div", "pbox"); tr.append(el("b", null, "Letzte Käufe & Verkäufe"));
  const tt = el("table", "mvtable"); tt.append(...[["Zeit", "", "Markt", "Preis", "Ergebnis netto", "Strategie"], ...d.trades.slice(0, 15).map((t) => [new Date(t.ts).toLocaleString("de-DE"), t.action === "ENTRY" ? "Kauf" : "Verkauf", t.symbol, t.price, t.pnl == null ? "–" : sgn(t.pnl), strategyLabel(t.strategy || "")])]
    .map((r, i) => { const row = el("tr"); r.forEach((x, j) => { const td = el(i ? "td" : "th", i && j === 4 && x !== "–" ? (Number(x) >= 0 ? "ok" : "bad") : "", typeof x === "number" ? (x >= 100 ? x.toFixed(2) : x.toFixed(4)) : x); row.append(td); }); return row; }));
  tr.append(d.trades.length ? tt : el("div", "muted", "noch keine Trades")); parts.push(tr);
  if (!d.main && d.curve.length > 1) { const c = el("div", "pbox"); c.append(el("b", null, "Eigenkapital-Verlauf dieses Modus")); const cv = el("canvas"); cv.id = "mvcurve"; cv.style.cssText = "width:100%;height:180px;display:block"; c.append(cv); parts.push(c); box._curve = d; }
  if (d.decisions.length) { const dc = el("div", "pbox"); dc.append(el("b", null, "Letzte Entscheidungen")); for (const x of d.decisions) dc.append(el("div", "muted", `${new Date(x.ts).toLocaleTimeString("de-DE")} ${String(x.text).replace(/^.*? · /, "")}`)); parts.push(dc); }
  const lg = el("div", "pbox"); const b = el("button", "btn", "📂 Log-Ordner öffnen"); b.onclick = () => window.electronBridge?.openLogs(); lg.append(b, el("span", "muted", "  Jede Stunde und alle 6 Stunden wird für diesen Modus eine Datei gespeichert."));
  parts.push(lg);
  box.replaceChildren(...parts);
  if (box._curve) { drawMini($("mvcurve"), box._curve.curve, box._curve.capital); box._curve = null; }
}
function drawMini(cv, pts, base) {
  if (!cv || pts.length < 2) return;
  const dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight; cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext("2d"); g.scale(dpr, dpr);
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), vals = pts.map((p) => p[1]).concat(base);
  let lo = Math.min(...vals), hi = Math.max(...vals); const m = Math.max((hi - lo) * 0.1, 0.5); lo -= m; hi += m;
  const X = (t) => 8 + ((t - pts[0][0]) / Math.max(1, pts.at(-1)[0] - pts[0][0])) * (W - 16), Y = (v) => 6 + (1 - (v - lo) / (hi - lo)) * (H - 12);
  g.setLineDash([5, 4]); g.strokeStyle = css("--muted"); g.beginPath(); g.moveTo(8, Y(base)); g.lineTo(W - 8, Y(base)); g.stroke(); g.setLineDash([]);
  g.strokeStyle = pts.at(-1)[1] >= base ? css("--ok") : css("--bad"); g.lineWidth = 2; g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(X(p[0]), Y(p[1])) : g.moveTo(X(p[0]), Y(p[1])))); g.stroke();
}
async function renderCompare() {
  await loadModes();
  if (!modes) return;
  const head = ["Modus", "Rolle", "Gewinn USD", "Gewinn %", "realisiert", "offen", "Trades", "Treffer", "Profitf.", "Max DD", "Gebühren", "Strategien"];
  const t = $("cmpTable"), rows = [];
  rows.push(Object.assign(el("tr"), {}));
  head.forEach((h) => rows[0].append(el("th", null, h)));
  for (const [bot, label] of BOTS) {
    const g = el("tr", "grp"), td = el("td", null, label); td.colSpan = head.length; g.append(td); rows.push(g);
    const mine = modes.rows.filter((r) => r.bot === bot), best = Math.max(...mine.filter((r) => !r.off).map((r) => r.profit));
    for (const r of mine) {
      const tr = el("tr", r.off ? "offrow" : r.profit === best && best > 0 ? "best" : "");
      const cells = r.off ? [r.label, "aus", "", "", "", "", "", "", "", "", "", ""] : [`${r.main ? "★ " : ""}${r.label}`, r.main ? "Haupt" : "Schatten", sgn(r.profit), sgn(r.pct), sgn(r.realized), sgn(r.unrealized), r.trades, r.winRate == null ? "–" : `${r.winRate.toFixed(0)} %`,
        r.profitFactor === Infinity ? "∞" : r.profitFactor == null ? "–" : r.profitFactor.toFixed(2), r.main ? "–" : `${r.maxDrawdownPct.toFixed(1)} %`, r.fees.toFixed(2), `${r.active}/${r.approved}`];
      cells.forEach((x, j) => { const c = el("td", !r.off && (j === 2 || j === 3) ? (Number(x) >= 0 ? "ok" : "bad") : "", String(x)); tr.append(c); });
      tr.style.cursor = r.off ? "default" : "pointer"; if (!r.off) tr.onclick = () => { subMode[bot] = r.mode; select(bot); };
      rows.push(tr);
    }
  }
  t.replaceChildren(...rows);
}
$("cmpLogs").onclick = () => window.electronBridge?.openLogs();
$("cmpReset").onclick = async () => { if (!confirm("Alle Schatten-Läufe auf frisches Paper-Geld zurücksetzen? Ihre Trades und Statistiken werden gelöscht (der Haupt-Modus bleibt unberührt).")) return; try { await call("resetShadows"); await renderCompare(); } catch (e) { alert(e.message); } };

// ---- Handy-/Browser-Zugang (nur in der Desktop-App; am Handy selbst gibt es den Knopf nicht) ----
const bridge = window.electronBridge;
if (!bridge?.remoteGet) $("remoteBtn").hidden = true;
async function openRemote() {
  const modal = $("remoteModal"), box = $("remoteBox");
  const draw = (s) => {
    const parts = [el("h3", null, "📱 Handy / Browser")];
    parts.push(el("p", "muted", "Dieselbe Oberfläche (alle Tabs, Dashboard, Einstellungen) auf dem Handy oder in einem anderen Browser. Der Bot läuft weiter auf diesem PC – er muss dafür an sein."));
    const row1 = el("label", "fld chk"), cb = el("input"); cb.type = "checkbox"; cb.checked = s.enabled; row1.append(cb, document.createTextNode(" Zugriff erlauben (standardmäßig aus)"));
    cb.onchange = async () => { if (cb.checked && !confirm("Zugriff vom Handy/Browser einschalten? Die App öffnet dazu einen Port im Heimnetz (Windows fragt evtl. nach der Firewall: „Private Netzwerke“ zulassen). Nur Personen mit dem Schlüssel-Link kommen hinein.")) { cb.checked = false; return; } draw(await bridge.remoteSet({ enabled: cb.checked })); };
    parts.push(row1);
    const sel = el("select"); for (const [v, l] of [["view", "Nur ansehen (empfohlen)"], ["control", "Steuern: kaufen, verkaufen, Stop/Ziel, Einstellungen"]]) { const o = el("option", null, l); o.value = v; sel.append(o); }
    sel.value = s.mode; sel.onchange = async () => { if (sel.value === "control" && !confirm("„Steuern“ erlaubt jedem mit dem Link, Trades auszulösen, Bots zu stoppen und Einstellungen zu ändern. Wallet-Aktionen bleiben am PC gesperrt. Link geheim halten – trotzdem aktivieren?")) { sel.value = s.mode; return; } draw(await bridge.remoteSet({ mode: sel.value })); };
    const l2 = el("label", "fld"); l2.append(document.createTextNode("Was darf das Handy? "), sel); parts.push(l2);
    if (s.enabled && s.running) {
      parts.push(el("div", "muted", `Läuft auf Port ${s.port}. Öffne am Handy (gleiches WLAN) einen dieser Links – am einfachsten den QR-Code scannen. Beim ersten Öffnen wird der Schlüssel im Browser gespeichert; danach reicht die Adresse ohne Schlüssel. „Zum Startbildschirm hinzufügen“ macht daraus eine App.`));
      if (!s.urls.length) parts.push(el("div", "bad", "Keine Netzwerkadresse gefunden – ist der PC mit WLAN/LAN verbunden?"));
      for (const u of s.urls) {
        const box2 = el("div", "qr"); if (u.qr) { const img = el("img"); img.src = u.qr; img.width = 140; img.height = 140; img.alt = "QR-Code"; box2.append(img); }
        const t = el("div"); t.append(el("b", null, `${u.name} (${u.ip})`), el("br"), el("code", null, u.url));
        const cp = el("button", "btn", "Link kopieren"); cp.onclick = () => navigator.clipboard?.writeText(u.url).then(() => { cp.textContent = "Kopiert ✓"; }); t.append(el("br"), cp); box2.append(t); parts.push(box2);
      }
      parts.push(el("div", "muted", "Anderes WLAN / Mobilfunk: Dafür ist ein privates VPN nötig, z. B. Tailscale (auf PC und Handy installieren, anmelden; dann den Link mit der Tailscale-Adresse des PCs (100.x.x.x) verwenden). Im WLAN ist die Verbindung unverschlüsselt – nie im öffentlichen WLAN verwenden, und keinen Port am Router freigeben."));
      const rg = el("button", "btn", "Neuen Schlüssel erzeugen (alte Links/Handys sind danach ausgesperrt)"); rg.onclick = async () => { if (confirm("Alle bisherigen Links und angemeldeten Handys werden ungültig. Fortfahren?")) draw(await bridge.remoteSet({ regenerate: true })); }; parts.push(rg);
    }
    const close = el("button", "btn primary", "Schließen"); close.onclick = () => { modal.hidden = true; }; const r = el("div", "btns"); r.append(close); parts.push(r);
    box.replaceChildren(...parts);
  };
  draw(await bridge.remoteGet());
  modal.hidden = false;
}
$("remoteBtn").onclick = () => openRemote().catch((e) => alert(e.message));
$("remoteModal").onclick = (e) => { if (e.target === $("remoteModal")) $("remoteModal").hidden = true; };

// ---- Profit-Tab ----
const sg = (x, d = 2) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
let pdata = null, prange = "7";
async function renderProfit() {
  if ($("profit").hidden) return;
  try { pdata = await call("getProfit"); } catch (e) { $("pcards").textContent = e.message; return; }
  const names = { today: "Heute", week: "Letzte Woche (7 Tage)", month: "Letzte 30 Tage", total: "Insgesamt (seit Start)" };
  $("pcards").replaceChildren(...Object.entries(names).map(([k, label]) => {
    const p = pdata.periods[k], c = document.createElement("div");
    c.className = "pcard";
    c.innerHTML = '<h3></h3><div class="big"></div><div class="sm"></div>';
    c.querySelector("h3").textContent = label;
    const big = c.querySelector(".big"); big.textContent = `${sg(p.usd)} USD (${sg(p.pct)} %)`; big.className = `big ${p.usd >= 0 ? "ok" : "bad"}`;
    c.querySelector(".sm").textContent = `realisiert ${sg(p.realized)} USD · ${p.buys} Käufe, ${p.sells} Verkäufe${p.sells ? ` (${p.wins} Gewinn, ${p.winRate.toFixed(0)} %)` : ""}\nGebühren ${p.fees.toFixed(2)} USD${p.partial ? " · Verlauf beginnt später" : ""}`;
    c.querySelector(".sm").style.whiteSpace = "pre-line";
    return c;
  }));
  $("pranges").replaceChildren(...[["1", "1 Tag"], ["7", "7 Tage"], ["30", "30 Tage"], ["0", "Alles"]].map(([v, l]) => {
    const b = document.createElement("button"); b.textContent = l; b.className = prange === v ? "on" : ""; b.onclick = () => { prange = v; renderProfit(); }; return b;
  }));
  const rows = [["Bot", "Heute", "7 Tage", "Gesamt", "Trades"]];
  for (const [id, label] of BOTS) { const b = pdata.bots[id]; rows.push([label, sg(b.today.realized), sg(b.week.realized), sg(b.total.realized), `${b.total.buys} / ${b.total.sells}`]); }
  $("pbots").replaceChildren(...rows.map((r, i) => { const tr = document.createElement("tr"); r.forEach((x, j) => { const td = document.createElement(i ? "td" : "th"); td.textContent = x; if (i && j >= 1 && j <= 3) td.className = Number(x) >= 0 ? "ok" : "bad"; tr.append(td); }); return tr; }));
  const P = pdata.perf, f2 = (x, d = 2) => (x == null || !Number.isFinite(x) ? "–" : x.toFixed(d));
  $("pbreaker").hidden = !pdata.breaker;
  if (pdata.breaker) $("pbreaker").textContent = `🛑 NOT-AUS-BREMSE ausgelöst am ${new Date(pdata.breaker.ts).toLocaleString("de-DE")}: Eigenkapital ${pdata.breaker.equity.toFixed(2)} USD lag ${pdata.breaker.pct} % unter dem Höchststand ${pdata.breaker.peak.toFixed(2)} USD. Alle Positionen wurden geschlossen, alle Bots gestoppt. „Alle starten“ (oder „Bot starten“) hebt die Bremse auf und setzt den Höchststand neu.`;
  const cells = [["Abgeschlossene Trades", P.trades], ["Trefferquote", P.winRate == null ? "–" : `${P.winRate.toFixed(0)} % (${P.wins}/${P.trades})`], ["Profitfaktor", P.profitFactor === Infinity ? "∞" : f2(P.profitFactor)],
    ["Erwartungswert je Trade", P.expectancy == null ? "–" : `${sg(P.expectancy)} USD`], ["Ø Gewinn / Ø Verlust", `${f2(P.avgWin)} / ${f2(P.avgLoss)} USD`], ["Gewinn-Verlust-Verhältnis", f2(P.payoff)],
    ["Bester / schlechtester Trade", `${f2(P.best)} / ${f2(P.worst)} USD`], ["Aktuelle Serie", P.streak > 0 ? `${P.streak} Gewinne in Folge` : P.streak < 0 ? `${-P.streak} Verluste in Folge` : "–"],
    ["Längste Gewinn- / Verlustserie", `${P.maxWinStreak} / ${P.maxLossStreak}`], ["Bester Tag", P.bestDay ? `${sg(P.bestDay[1])} USD (${P.bestDay[0]})` : "–"], ["Schlechtester Tag", P.worstDay ? `${sg(P.worstDay[1])} USD (${P.worstDay[0]})` : "–"],
    ["Drawdown jetzt (vom Höchststand)", `${f2(P.drawdown)} USD (${f2(P.drawdownPct, 1)} %)`], ["Max. Drawdown bisher", `${f2(P.maxDrawdown)} USD (${f2(P.maxDrawdownPct, 1)} %)`], ["Höchststand Eigenkapital", P.peak == null ? "–" : `${f2(P.peak)} USD`]];
  $("pperf").replaceChildren(...cells.map(([k, v]) => { const d = document.createElement("div"), s = document.createElement("small"), b = document.createElement("strong"); s.textContent = k; b.textContent = v; d.append(s, b); return d; }));
  const srows = [["Strategie", "Trades", "Trefferquote", "Ø je Trade", "Ergebnis"]];
  for (const r of pdata.strategies) srows.push([r.name, r.trades, `${r.winRate.toFixed(0)} %`, sg(r.avg), sg(r.pnl)]);
  if (srows.length === 1) srows.push(["noch keine abgeschlossenen Trades", "", "", "", ""]);
  $("pstrat").replaceChildren(...srows.map((r, i) => { const tr = document.createElement("tr"); r.forEach((x, j) => { const td = document.createElement(i ? "td" : "th"); td.textContent = x; if (i && j >= 3 && x !== "") td.className = Number(x) >= 0 ? "ok" : "bad"; tr.append(td); }); return tr; }));
  tip(`Trading-Bot · heute ${sg(pdata.periods.today.usd)} USD · gesamt ${sg(pdata.periods.total.usd)} USD`);
  drawCurve();
}
$("pcsv").onclick = async () => {
  try {
    const r = await call("exportTrades");
    if (!r.count) return alert("Noch keine Trades zum Exportieren.");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([r.csv], { type: "text/csv;charset=utf-8" }));
    a.download = `trades_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(a); a.click(); a.remove();
  } catch (e) { alert(e.message); }
};
const tip = (text) => { try { window.electronBridge?.tip(text); } catch { /* Tooltip ist nur Zugabe */ } };   // Symbol im Infobereich zeigt den Gewinn
function drawCurve() {
  const cv = $("pcurve"), dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  if (!pdata || !W) return;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext("2d"); g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
  const from = prange === "0" ? 0 : Date.now() - Number(prange) * 86400000;
  let pts = pdata.curve.filter((p) => p[0] >= from);
  if (pts.length < 2) pts = pdata.curve.slice(-2);
  if (pts.length < 2) { g.fillStyle = getComputedStyle(document.body).color; g.fillText("Noch zu wenig Verlauf – der Bot schreibt alle 5 Minuten einen Punkt.", 12, 24); return; }
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const vals = pts.map((p) => p[1]).concat(pdata.capital);
  let lo = Math.min(...vals), hi = Math.max(...vals); const m = Math.max((hi - lo) * 0.1, 0.5); lo -= m; hi += m;
  const padL = 56, padR = 10, padT = 8, padB = 22, X = (t) => padL + ((t - pts[0][0]) / Math.max(1, pts.at(-1)[0] - pts[0][0])) * (W - padL - padR), Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  g.font = "11px system-ui"; g.textBaseline = "middle";
  for (let k = 0; k <= 4; k++) { const v = lo + ((hi - lo) * k) / 4, y = Y(v); g.strokeStyle = css("--line"); g.beginPath(); g.moveTo(padL, y); g.lineTo(W - padR, y); g.stroke(); g.fillStyle = css("--muted"); g.fillText(v.toFixed(2), 4, y); }
  g.setLineDash([5, 4]); g.strokeStyle = css("--muted"); g.beginPath(); g.moveTo(padL, Y(pdata.capital)); g.lineTo(W - padR, Y(pdata.capital)); g.stroke(); g.setLineDash([]);
  g.fillStyle = css("--muted"); g.fillText("Start", W - padR - 34, Y(pdata.capital) - 8);
  const up = pts.at(-1)[1] >= pts[0][1], col = up ? css("--ok") : css("--bad");
  g.strokeStyle = col; g.lineWidth = 2; g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(X(p[0]), Y(p[1])) : g.moveTo(X(p[0]), Y(p[1])))); g.stroke(); g.lineWidth = 1;
  g.fillStyle = css("--muted");
  const fmtT = (t) => new Date(t).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  g.fillText(fmtT(pts[0][0]), padL, H - 8); g.fillText(fmtT(pts.at(-1)[0]), W - padR - 90, H - 8);
}
addEventListener("resize", drawCurve);
select(active);

async function refresh() {
  try {
    const a = await call("getAccount");
    $("equity").textContent = money(a.equity);
    $("pnl").textContent = `${a.pnl >= 0 ? "+" : ""}${a.pnl.toFixed(2)} (${a.pnlPct >= 0 ? "+" : ""}${a.pnlPct.toFixed(2)} %)`;
    $("pnl").className = a.pnl >= 0 ? "ok" : "bad";
    $("cash").textContent = money(a.cash);
    if (a.today) {
      tip(`Trading-Bot · heute ${sg(a.today.usd)} USD (${sg(a.today.pct)} %) · gesamt ${sg(a.pnl)} USD`);
      $("today").textContent = `${sg(a.today.usd)} USD`; $("today").className = a.today.usd >= 0 ? "ok" : "bad";
      $("todayPct").textContent = `(${sg(a.today.pct)} %)`; $("todayPct").className = a.today.usd >= 0 ? "ok" : "bad";
    }
    $("held").textContent = money(a.held);
    $("split").textContent = a.bots.map((b) => `${b.label}: ${b.value.toFixed(0)}`).join(" · ");
    $("mode").textContent = a.bots.some((b) => b.live) ? "PAPER + LIVE-KRYPTO" : "PAPER";
    for (const b of a.bots) {
      const el = $(`tab-${b.id}`), dot = el.querySelector(".dot");
      dot.className = `dot ${b.killRequested || b.pending || b.locked || b.lastError && b.enabled ? "bad" : b.enabled ? "on" : ""}`;
      el.querySelector(".lbl").textContent = `${BOTS.find(([id]) => id === b.id)[1]}${b.positions ? ` (${b.positions})` : ""}`;
      el.title = `${b.enabled ? "läuft" : "gestoppt"} · ${b.positions} Position(en) · ${b.approvedActive} aktive Strategie(n)${b.lastError && b.enabled ? " · Fehler: " + b.lastError : ""}`;
    }
    $("note").hidden = true;
  } catch (e) { showDiag(e.message); }
}

async function showDiag(msg) {   // statt leerer Seite: was ist los? (zum Weitergeben/Screenshot)
  let d = {};
  try { d = await (window.electronBridge || {}).diag(); } catch { /* ohne Diagnose */ }
  $("note").hidden = false;
  $("note").style.cssText = "white-space:pre-wrap;color:#fff;background:#7a1f1f;padding:6px 16px;font-size:12px";
  $("note").textContent = `Der Hintergrunddienst antwortet nicht: ${msg}\n` + `Version ${d.version} · ${d.platform} · Electron ${d.electron} · ext vorhanden: ${d.extExists} · Hintergrund: ${d.bgUrl} (lädt: ${d.bgLoading})\n` +
    `Datenordner: ${d.userData} · gespeicherte Schlüssel: ${(d.storageKeys || []).join(", ") || "–"}\n` + `Letzte Fehler:\n${(d.errors || []).join("\n") || "(keine)"}`;
}
setTimeout(() => { if ($("equity").textContent === "–") showDiag("noch keine Antwort nach 10 s"); }, 10000);

const act = (fn) => async () => { try { await fn(); } catch (e) { alert(e.message); } refresh(); document.querySelectorAll("iframe").forEach((f) => f.contentWindow?.postMessage({ type: "refresh" }, "*")); };
$("startAll").onclick = act(() => call("startAll"));
$("stopAll").onclick = act(() => call("stopAll"));
$("killAll").onclick = act(async () => {
  if (!confirm("NOT-AUS für ALLE drei Bots: alle offenen Positionen werden sofort geschlossen und alle Bots gestoppt. Fortfahren?")) return;
  await call("killAll");
});

refresh();
loadModes().then(() => select(active));
setInterval(async () => { await loadModes(); if (BOTS.some(([b]) => b === active)) { renderSubtabs(active); const sub = subMode[active] || mainOf(active); if (sub !== mainOf(active)) renderMode(active, sub); } if (active === "compare") renderCompare(); }, 15000);
setInterval(refresh, 5000);
setInterval(renderProfit, 15000);
