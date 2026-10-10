// Popup: Status, Strategien, Trades, Wallet. Alle Inhalte werden per textContent gesetzt (kein innerHTML).
const view = document.getElementById("view"), errorBox = document.getElementById("error");
let tab = "status", status = null, balances = null, secretToShow = null, busy = false;

function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return e;
}

async function call(type, extra = {}) {
  const r = await chrome.runtime.sendMessage({ type, ...extra });
  if (!r?.ok) throw new Error(r?.error || "Keine Antwort vom Hintergrunddienst");
  return r.result;
}

function showError(msg) { errorBox.hidden = !msg; errorBox.textContent = msg || ""; }

async function act(fn) {
  if (busy) return;
  busy = true; showError("");
  try { await fn(); } catch (e) { showError(e.message); } finally { busy = false; await refresh(); }
}

const fmt = (x, d = 2) => (x == null || Number.isNaN(x) ? "–" : Number(x).toFixed(d));
const row = (k, v, cls = "") => h("div", { class: "row" }, h("span", { class: "muted" }, k), h("span", { class: cls }, v));
const card = (title, ...kids) => h("div", { class: "card" }, h("h3", {}, title), ...kids);
const btn = (label, onclick, cls = "", disabled = false) => h("button", { class: `btn ${cls}`, onclick, disabled }, label);
const ago = (iso) => (iso ? `${Math.round((Date.now() - Date.parse(iso)) / 60000)} min her` : "–");

// ---------------------------------------------------------------- Aktivität
const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

function activityCard() {
  const { state } = status, a = state.activity, secs = state.lastTick ? (Date.now() - Date.parse(state.lastTick)) / 1000 : null;
  const alive = state.enabled && secs != null && secs < 120;
  const dot = h("span", { class: `dot ${alive ? "alive" : state.enabled ? "stale" : "off"}` });
  const failing = state.enabled && state.lastError && !alive;
  const headline = !state.enabled ? "Bot gestoppt" : state.status ? state.status
    : failing ? `Durchlauf fehlgeschlagen: ${state.lastError}`
    : secs == null ? "Wartet auf den ersten Durchlauf (alle 30 s) …" : alive ? "Bot arbeitet" : "Kein Lebenszeichen – ist der Browser aktiv?";
  const lines = [h("div", { class: "headline" }, dot, headline)];
  if (state.enabled && secs != null) lines.push(row("Letzte Prüfung", `vor ${Math.round(secs)} s`));
  if (a) {
    lines.push(row("SOL-Kurs", a.price != null ? `${fmt(a.price)} USD` : "–"),
      row("Marktphase", a.regime ? `${a.regime} · Vol. ${a.volatility} · ADX ${fmt(a.adx, 0)}` : (a.note || "–")),
      row("Gewählte Strategie", a.strategy ?? "keine passende zugelassen", a.strategy ? "" : "muted"),
      row("Einstiegssignal", a.signal == null ? "–" : a.signal ? "JA (wird bei Kerzenschluss geprüft)" : "nein", a.signal ? "ok" : ""),
      row("Nächste Kerzenprüfung in", h("span", { id: "countdown", "data-t": a.nextCandleAt }, mmss(a.nextCandleAt - Date.now()))));
  }
  if (state.enabled && state.report.length && !state.approved.length && !state.status) lines.push(h("div", { class: "hint" }, "Keine Strategie hat den Backtest bestanden – der Bot wartet und prüft täglich neu."));
  if (status.state.decisions?.length) lines.push(h("div", { class: "decisions" }, ...status.state.decisions.map((d) =>
    h("div", {}, h("span", { class: "muted" }, new Date(d.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + " "), d.text))));
  return card("Aktivität", ...lines);
}

// Countdown läuft sekündlich, ohne das Popup neu zu zeichnen.
setInterval(() => { const c = document.getElementById("countdown"); if (c) c.textContent = mmss(Number(c.dataset.t) - Date.now()); }, 1000);

// ---------------------------------------------------------------- Status
function renderStatus() {
  const { cfg, state, vault } = status, live = cfg.liveTrading, pos = Object.values(state.positions)[0];
  const out = [];
  if (state.pending) out.push(h("div", { class: "error" }, `Unklarer Orderstatus (${state.pending.what}). Bot gestoppt – Wallet prüfen, dann bestätigen. `,
    btn("Geprüft, zurücksetzen", () => act(() => call("clearPending")))));
  if (state.killRequested) out.push(h("div", { class: "error" }, "Not-Aus aktiv: Position konnte nicht (vollständig) geschlossen werden. ",
    btn("Not-Aus aufheben", () => act(() => call("clearKill")))));
  if (live && state.locked) out.push(h("div", { class: "error" }, "Wallet gesperrt – Bot kann weder handeln noch Stops auslösen. Im Tab „Wallet“ entsperren."));
  if (live) out.push(h("div", { class: "warn" }, "LIVE-Modus: echte Orders mit echtem Geld. Der Stop-Loss wird nur vom Bot überwacht und wirkt nur, solange Browser und Wallet entsperrt laufen."));

  out.push(activityCard());
  out.push(card("Bot",
    row("Zustand", state.enabled ? "läuft" : "gestoppt", state.enabled ? "ok" : "muted"),
    row("Letzter Durchlauf", ago(state.lastTick)),
    row("Strategien geprüft", `${ago(state.lastRefresh)} · ${state.approved.length} zugelassen`),
    state.lastError && row("Letzter Fehler", state.lastError, "bad"),
    h("div", { class: "btns" },
      state.enabled ? btn("Stoppen", () => act(() => call("stop"))) : btn("Bot starten", () => act(() => call("start")), "primary"),
      btn("Strategien neu prüfen", () => act(async () => { const r = await call("research"); showError(""); alert(`${r.approved} von ${r.tested} Tests bestanden (${r.candles} Kerzen).`); })),
      state.enabled && btn("Jetzt prüfen", () => act(() => call("tickNow"))),
    ),
    h("div", { class: "btns" }, btn("NOT-AUS: Position schließen & stoppen", () => act(() => call("kill")), "danger")),
  ));

  out.push(card("Position",
    pos ? [row("Menge", `${fmt(pos.amount, 4)} SOL`), row("Einstieg", fmt(pos.entryPrice)), row("Stop-Loss", fmt(pos.stop), "bad"),
      row("Ziel", fmt(pos.takeProfit), "ok"), row("Strategie", pos.strategyName), row("Marktphase", pos.regime)]
      : h("span", { class: "muted" }, "Keine offene Position."),
  ));

  const daily = state.risk?.startEquity;
  out.push(card("Konto & Risiko",
    live ? row("Wallet", vault.address || "–", "mono") : row("Paper-Guthaben (USD)", fmt(state.paperCash ?? cfg.capital.start)),
    row("Tageslimit", state.risk?.halted ? "erreicht – Handel pausiert" : `max. ${cfg.risk.maxDailyLossPct}% Verlust`, state.risk?.halted ? "bad" : ""),
    daily && row("Tagesstart-Eigenkapital", fmt(daily)),
    row("Risiko pro Trade", `${cfg.risk.riskPerTradePct}%`),
  ));
  if (status.events.length) out.push(card("Letzte Ereignisse", ...status.events.slice(0, 5).map((e) =>
    h("div", {}, h("span", { class: "muted" }, new Date(e.ts).toLocaleTimeString() + " "), e.text))));
  return out;
}

// ------------------------------------------------------------ Strategien
function renderStrategies() {
  const { report, approved } = status.state;
  if (!report.length) return [h("p", { class: "muted" }, "Noch keine Backtests. Bot starten oder „Strategien neu prüfen“."),
    btn("Strategien neu prüfen", () => act(() => call("research")), "primary")];
  const rows = [...report].sort((a, b) => (b.approved - a.approved) || (b.metrics.sharpe - a.metrics.sharpe));
  return [
    h("p", { class: "muted" }, `${approved.length} von ${report.length} zugelassen. Mindestwerte in den Einstellungen.`),
    h("table", {}, h("thead", {}, h("tr", {}, ...["Strategie", "Rend.%", "DD%", "Sharpe", "Treffer%", "n"].map((t) => h("th", {}, t)))),
      h("tbody", {}, ...rows.map((r) => h("tr", { title: r.failures.join("; ") },
        h("td", { class: r.approved ? "ok" : "muted" }, (r.approved ? "✔ " : "✘ ") + r.strategy + (r.source === "llm" ? " (LLM)" : "")),
        h("td", {}, fmt(r.metrics.return_pct)), h("td", {}, fmt(r.metrics.max_drawdown_pct)), h("td", {}, fmt(r.metrics.sharpe)),
        h("td", {}, fmt(r.metrics.win_rate_pct, 0)), h("td", {}, r.metrics.trades))))),
    h("p", { class: "hint" }, "Mauszeiger über eine Zeile zeigt, warum eine Strategie abgelehnt wurde."),
  ];
}

// ---------------------------------------------------------------- Trades
function renderTrades() {
  if (!status.trades.length) return [h("p", { class: "muted" }, "Noch keine Trades.")];
  return status.trades.map((t) => h("div", { class: "card" },
    row(`${t.action} · ${t.mode}`, new Date(t.ts).toLocaleString()),
    row("Preis / Menge", `${fmt(t.price)} / ${fmt(t.amount, 4)}`),
    t.pnl != null && row("Ergebnis (netto)", `${t.pnl >= 0 ? "+" : ""}${fmt(t.pnl)} USD`, t.pnl >= 0 ? "ok" : "bad"),
    h("div", { class: "muted" }, t.reason)));
}

// ---------------------------------------------------------------- Wallet
function renderWallet() {
  const { vault, cfg } = status, pw = h("input", { type: "password", placeholder: "Passwort (min. 8 Zeichen)", autocomplete: "off" });
  const out = [];
  if (secretToShow) {
    out.push(h("div", { class: "warn" }, h("strong", {}, "Backup – jetzt offline sichern! "),
      "Wer diesen Schlüssel hat, kann die Wallet leeren. Geh sicher, dass niemand zusieht, und zeig ihn niemandem."),
      h("div", { class: "secret mono" }, secretToShow),
      h("div", { class: "btns" }, btn("Ich habe es gesichert – ausblenden", () => { secretToShow = null; refresh(); }, "primary")));
    return out;
  }
  if (!vault.exists) {
    const key = h("input", { type: "password", placeholder: "Privater Schlüssel (Base58) zum Importieren", autocomplete: "off" });
    out.push(h("div", { class: "warn" }, "Lege eine EIGENE Bot-Wallet an (nicht deine Haupt-Wallet) und zahle nur Geld ein, dessen Verlust du verkraftest. ",
      "Der Schlüssel wird mit deinem Passwort verschlüsselt im Browser gespeichert."),
      card("Neue Wallet", pw, btn("Neue Wallet erzeugen", () => act(async () => { secretToShow = (await call("createWallet", { password: pw.value })).backupKey; }), "primary")),
      card("Vorhandenen Schlüssel importieren", key, btn("Importieren", () => act(async () => { await call("importWallet", { password: pw.value, key: key.value }); key.value = ""; }))));
    return out;
  }
  out.push(card("Wallet",
    row("Adresse", vault.address, "mono"),
    row("Status", vault.unlocked ? "entsperrt" : "gesperrt", vault.unlocked ? "ok" : "bad"),
    balances && row("Guthaben", `${fmt(balances.usdc)} USDC · ${fmt(balances.sol, 4)} SOL`),
    h("div", { class: "btns" }, btn("Guthaben abrufen", () => act(async () => { balances = await call("balances"); }))),
  ));
  out.push(card("Passwort-Aktionen", pw, h("div", { class: "btns" },
    vault.unlocked ? btn("Sperren", () => act(() => call("lock"))) : btn("Entsperren", () => act(() => call("unlock", { password: pw.value })), "primary"),
    btn("Backup-Schlüssel anzeigen", () => act(async () => { secretToShow = await call("exportKey", { password: pw.value }); })),
    btn("Wallet löschen", () => act(async () => {
      if (!confirm("Wallet-Schlüssel aus dem Browser löschen? Ohne Backup ist das Guthaben verloren!")) return;
      await call("deleteWallet", { password: pw.value }); balances = null;
    }), "danger"))));
  if (cfg.liveTrading && !vault.unlocked) out.unshift(h("div", { class: "error" }, "Nach jedem Browser-Neustart musst du die Wallet erneut entsperren, sonst handelt der Bot nicht."));
  return out;
}

// ---------------------------------------------------------------- Rahmen
const RENDER = { status: renderStatus, strategies: renderStrategies, trades: renderTrades, wallet: renderWallet };

function draw() {
  const pill = document.getElementById("mode");
  pill.textContent = status.cfg.liveTrading ? "LIVE" : "PAPER";
  pill.className = `pill ${status.cfg.liveTrading ? "live" : ""}`;
  view.replaceChildren(...RENDER[tab]());
}

async function refresh() {
  try { status = await call("getStatus"); showError(errorBox.textContent); draw(); }
  catch (e) { showError(e.message); }
}

document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => {
  tab = b.dataset.tab;
  document.querySelectorAll("nav button").forEach((x) => x.classList.toggle("active", x === b));
  if (status) draw();
}));

refresh();
// Nicht neu zeichnen, solange der Nutzer in einem Passwortfeld tippt oder ein Schlüssel angezeigt wird.
setInterval(() => { if (!busy && !secretToShow && !document.activeElement?.matches?.("input")) refresh(); }, 5000);
