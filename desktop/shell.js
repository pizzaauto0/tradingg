// Rahmen der Desktop-App: gemeinsames Paper-Konto oben, darunter ein Tab je Bot (Währungen, Silber & Gold, Krypto).
// Jeder Tab ist die unveränderte Popup-Seite der Erweiterung mit ?bot=<id>.
const BOTS = [["fx", "Währungen"], ["metals", "Silber & Gold"], ["crypto", "Krypto"]];
const TABS = [...BOTS, ["profit", "💰 Profit"]];
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
  $("frames").hidden = id === "profit"; $("profit").hidden = id !== "profit";
  if (id === "profit") renderProfit();
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
  $("tabs").append(b);
}

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
    $("note").textContent = NOTE;
  } catch (e) { showDiag(e.message); }
}

const NOTE = $("note").textContent;
async function showDiag(msg) {   // statt leerer Seite: was ist los? (zum Weitergeben/Screenshot)
  let d = {};
  try { d = await (window.electronBridge || {}).diag(); } catch { /* ohne Diagnose */ }
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
setInterval(refresh, 5000);
setInterval(renderProfit, 15000);
