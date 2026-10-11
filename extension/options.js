// Einstellungsseite: erzeugt das Formular aus einer Feldliste; Werte werden validiert (controller.saveConfig).
const form = document.getElementById("form"), errorBox = document.getElementById("error");

// [Pfad, Beschriftung, Typ, Hinweis]
const SECTIONS = [
  ["Handel", [
    ["assets.SOL", "SOL handeln", "asset"],
    ["assets.BTC", "BTC handeln (Wrapped-Token auf Solana, dünnere Liquidität)", "asset"],
    ["assets.ETH", "ETH handeln (Wrapped-Token auf Solana, dünnere Liquidität)", "asset"],
    ["timeframe", "Zeitrahmen", ["5m", "15m", "30m", "1h"]],
    ["capital.start", "Kapital (USD/USDC)", "number", "Paper: Startguthaben. Live: maximal eingesetztes USDC."],
  ]],
  ["Risikomanagement", [
    ["risk.riskPerTradePct", "Risiko pro Trade (%)", "number", "Erlaubt: größer 0 bis 2."],
    ["risk.maxDailyLossPct", "Max. Tagesverlust (%)", "number", "Danach Handelsstopp bis zum nächsten UTC-Tag."],
    ["risk.closePositionsOnDailyLimit", "Bei Tageslimit Position schließen", "bool"],
    ["risk.maxOpenPositions", "Max. offene Positionen", "number"],
    ["risk.maxPositionPct", "Max. Positionsgröße (% des Kapitals)", "number"],
    ["risk.atrStopMult", "Stop-Loss (x ATR)", "number"],
    ["risk.takeProfitRr", "Take-Profit (Vielfaches des Risikos)", "number"],
  ]],
  ["Kosten (für Backtest und Paper)", [
    ["costs.feePct", "Gebühr je Order (%)", "number"],
    ["costs.slippagePct", "Slippage je Order (%)", "number"],
  ]],
  ["Backtest-Mindestwerte", [
    ["backtest.profile", "Prüfmodus", ["strict", "explore"], "strict = strenge Mindestwerte (Standard, gilt für Live). explore = stark gelockert, NUR Paper: du siehst Trades, aber die Strategien sind nicht bewiesen und verlieren wahrscheinlich Geld. Wirkt auf alle Werte unten."],
    ["backtest.minTrades", "Min. Trades", "number"],
    ["backtest.minReturnPct", "Min. Rendite (%)", "number"],
    ["backtest.maxDrawdownPct", "Max. Drawdown (%)", "number"],
    ["backtest.minSharpe", "Min. Sharpe Ratio", "number"],
    ["backtest.minWinRatePct", "Min. Trefferquote (%)", "number"],
    ["backtest.minProfitFactor", "Min. Profit Factor", "number"],
    ["backtest.minOosReturnPct", "Min. Out-of-Sample-Rendite (%)", "number"],
    ["pipeline.revalidateHours", "Strategien neu prüfen alle (Stunden)", "number"],
    ["pipeline.maxActiveStrategies", "Anzahl aktiv gehandelter Strategien", "number", "Nur die besten N zugelassenen Strategien handeln (je Typ und Markt höchstens eine)."],
  ]],
  ["Solana / Jupiter", [
    ["solana.rpcUrl", "RPC-URL", "text", "Für Dauerbetrieb eigenen RPC-Anbieter eintragen (Helius, QuickNode, …)."],
    ["solana.jupiterUrl", "Jupiter-API-URL", "text"],
    ["solana.mints.BTC", "Token-Adresse BTC (leer = Standard, selbst prüfen!)", "text", "Gegen einen Solana-Explorer prüfen. Falsche Adressen fängt der Preisabgleich ab, aber prüfe sie trotzdem."],
    ["solana.mints.ETH", "Token-Adresse ETH (leer = Standard, selbst prüfen!)", "text"],
    ["solana.solReserve", "SOL-Reserve für Gebühren", "number"],
    ["solana.slippageBps", "Max. Slippage (Basispunkte)", "number"],
    ["solana.maxDeviationPct", "Abbruch bei Preisabweichung (%)", "number"],
    ["solana.maxPriceImpactPct", "Max. Preisauswirkung (%)", "number"],
    ["solana.priorityFeeLamports", "Prioritätsgebühr (Lamports)", "number"],
  ]],
  ["LLM-Strategie-Recherche (optional)", [
    ["llm.enabled", "Aktiv", "bool", "Vorschläge sind nur Kandidaten und müssen den Backtest bestehen."],
    ["llm.apiKey", "Anthropic-API-Schlüssel", "password", "Wird unverschlüsselt im Browser-Speicher abgelegt."],
    ["llm.model", "Modell", "text"],
  ]],
  ["Telegram (optional)", [
    ["telegram.enabled", "Aktiv", "bool"],
    ["telegram.token", "Bot-Token", "password", "Wird unverschlüsselt im Browser-Speicher abgelegt."],
    ["telegram.chatId", "Chat-ID", "text"],
  ]],
];

const get = (o, p) => p.split(".").reduce((x, k) => x?.[k], o);
function setPath(o, p, v) { const ks = p.split("."); let x = o; for (const k of ks.slice(0, -1)) x = x[k] ||= {}; x[ks.at(-1)] = v; }
const call = async (type, extra = {}) => { const r = await chrome.runtime.sendMessage({ type, ...extra }); if (!r?.ok) throw new Error(r?.error); return r.result; };

function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v); }
  for (const kid of kids.flat()) if (kid != null) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return e;
}

async function build() {
  const cfg = await call("getConfig"), inputs = [];
  const live = h("input", { type: "checkbox", id: "live" });
  live.checked = cfg.liveTrading;
  form.replaceChildren(
    h("h2", {}, "Betriebsart"),
    h("label", { class: "check" }, live, h("strong", {}, "LIVE-Modus (echte Orders mit echtem Geld)")),
    h("p", { class: "hint" }, "Ausgeschaltet = Paper-Trading mit Spielgeld. Live erfordert eine angelegte Wallet; getestet sollte zuerst wochenlang im Paper-Modus werden."),
  );
  for (const [title, fields] of SECTIONS) {
    form.append(h("h2", {}, title));
    for (const [path, label, type, hint] of fields) {
      let input;
      if (Array.isArray(type)) { input = h("select", {}, ...type.map((o) => h("option", { value: o }, o))); input.value = get(cfg, path); }
      else if (type === "asset") { input = h("input", { type: "checkbox" }); input.checked = cfg.assets.includes(path.split(".")[1]); }
      else if (type === "bool") { input = h("input", { type: "checkbox" }); input.checked = !!get(cfg, path); }
      else { input = h("input", { type: type === "number" ? "number" : type, step: "any" }); input.value = get(cfg, path) === "***" ? "" : get(cfg, path) ?? ""; if (get(cfg, path) === "***") input.placeholder = "(gespeichert – leer lassen zum Behalten)"; }
      inputs.push({ path, type, input });
      const isCheck = type === "bool" || type === "asset";
      form.append(h("label", { class: isCheck ? "check" : "" }, isCheck ? [input, label] : [label, input]));
      if (hint) form.append(h("div", { class: "hint" }, hint));
    }
  }
  form.append(h("div", { class: "btns" }, h("button", { class: "btn primary", type: "submit" }, "Speichern")));

  form.onsubmit = async (ev) => {
    ev.preventDefault();
    errorBox.hidden = true;
    try {
      const patch = {};
      const assets = [];
      for (const { path, type, input } of inputs) {
        if (type === "asset") { if (input.checked) assets.push(path.split(".")[1]); continue; }
        let v = type === "bool" ? input.checked : type === "number" ? Number(input.value) : input.value.trim();
        if (type === "password" && v === "") continue; // gespeicherten Wert behalten
        setPath(patch, path, v);
      }
      patch.liveTrading = live.checked;
      if (!assets.length) throw new Error("Mindestens ein Markt muss aktiv sein.");
      patch.assets = assets;
      if (live.checked && !cfg.liveTrading && prompt('LIVE-Modus aktivieren? Es werden echte Orders mit echtem Geld platziert.\nZur Bestätigung LIVE eintippen:') !== "LIVE") {
        throw new Error("Live-Modus nicht aktiviert (Bestätigung fehlt).");
      }
      for (const url of [patch.solana.rpcUrl, patch.solana.jupiterUrl]) { // Berechtigung für eigene Hosts anfragen
        const origin = `${new URL(url).origin}/*`;
        if (!(await chrome.permissions.contains({ origins: [origin] })) && !(await chrome.permissions.request({ origins: [origin] }))) {
          throw new Error(`Zugriff auf ${origin} wurde nicht erlaubt.`);
        }
      }
      await call("saveConfig", { patch });
      alert("Gespeichert.");
      build();
    } catch (e) { errorBox.textContent = e.message; errorBox.hidden = false; scrollTo(0, 0); }
  };
}

build();
