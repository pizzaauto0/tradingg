// Rahmen der Desktop-App: gemeinsames Paper-Konto oben, darunter ein Tab je Bot (Währungen, Silber & Gold, Krypto).
// Jeder Tab ist die unveränderte Popup-Seite der Erweiterung mit ?bot=<id>.
const BOTS = [["fx", "Währungen"], ["metals", "Silber & Gold"], ["crypto", "Krypto"]];
const $ = (id) => document.getElementById(id);
const call = async (type, extra = {}) => { const r = await chrome.runtime.sendMessage({ type, ...extra }); if (!r?.ok) throw new Error(r?.error || "Keine Antwort vom Hintergrunddienst"); return r.result; };
const money = (x) => (x == null ? "–" : Number(x).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " USD");

let active = "fx";
try { const t = localStorage.getItem("botTab"); if (BOTS.some(([id]) => id === t)) active = t; } catch { /* ohne Speicher: Standard-Tab */ }

function select(id) {
  active = id;
  try { localStorage.setItem("botTab", id); } catch { /* egal */ }
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.bot === id));
  document.querySelectorAll("iframe").forEach((f) => f.classList.toggle("active", f.dataset.bot === id));
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
select(active);

async function refresh() {
  try {
    const a = await call("getAccount");
    $("equity").textContent = money(a.equity);
    $("pnl").textContent = `${a.pnl >= 0 ? "+" : ""}${a.pnl.toFixed(2)} (${a.pnlPct >= 0 ? "+" : ""}${a.pnlPct.toFixed(2)} %)`;
    $("pnl").className = a.pnl >= 0 ? "ok" : "bad";
    $("cash").textContent = money(a.cash);
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
