// Einstellungsseite: erzeugt das Formular aus einer Feldliste; Werte werden validiert (controller.saveConfig).
import { ASSETS, BOTS, botAssets } from "./lib/config.js";
const BOT = BOTS[new URLSearchParams(location.search).get("bot")] ? new URLSearchParams(location.search).get("bot") : "crypto";
const IS_CRYPTO = BOT === "crypto";
const form = document.getElementById("form"), errorBox = document.getElementById("error");

// [Pfad, Beschriftung, Typ, Hinweis]
const SECTIONS = [
  ["Märkte (alle werden gescannt, gehandelt wird nur, was den Backtest besteht)", botAssets(BOT).map((base) =>
    [`assets.${base}`, `${ASSETS[base].symbol}${!IS_CRYPTO || base === "SOL" ? "" : " (Token auf Solana, oft dünnere Liquidität)"}`, "asset"])],
  ["Handel", [
    ["timeframe", "Zeitrahmen", ["5m", "15m", "30m", "1h", "1d"]],
    ["capital.start", "Kapital (USD/USDC)", "number", IS_CRYPTO ? "Paper: Startguthaben (gilt für ALLE Bots – gemeinsames Konto; Änderung wirkt erst nach „Paper-Konto zurücksetzen“). Live: maximal eingesetztes USDC." : "Startguthaben des gemeinsamen Paper-Kontos – gilt für alle drei Bots (Änderung wirkt erst nach „Paper-Konto zurücksetzen“)."],
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
  ["KI-Trailing: Stop-Loss und Take-Profit nachziehen", [
    ["trail.enabled", "Aktiv", "bool", "Zieht den Stop-Loss nach oben, sobald eine Position im Plus ist – nie nach unten. Regelbasiert (kein Sprachmodell), jede Anpassung wird mit Grund gemeldet. Pro Position im Dashboard abschaltbar."],
    ["trail.startUsd", "Start ab Gewinn (USD)", "number", "Ab diesem Gewinn (vor Gebühren) wird gesichert – Beispiel 40: bei +40 liegt der Stop bei +30."],
    ["trail.startR", "… oder ab Vielfachem des Risikos (R)", "number", "1 = sobald der Gewinn so groß ist wie das ursprüngliche Risiko. Es genügt eine der beiden Bedingungen (bei kleinem Konto greift meist diese)."],
    ["trail.lockFraction", "Gesicherter Anteil des Gewinns (0,3–0,95)", "number", "0,75 = bei +40 Stop bei +30. Bei starkem Aufwärtstrend automatisch 0,15 weniger, bei Seitwärts/Abwärts 0,10 mehr."],
    ["trail.extendTp", "Take-Profit bei starkem Trend nahe am Ziel um 1R anheben", "bool"],
  ]],
  ["Kosten (für Backtest und Paper)", [
    ["costs.feePct", "Gebühr je Order (%)", "number", "Gilt für Kauf UND Verkauf. Mindestwerte (bewusst hoch): Krypto 0,26 + 0,20 Rutschen, Währungen 0,03 + 0,03, Metalle 0,06 + 0,06 – niedrigere Eingaben werden angehoben."],
    ["costs.slippagePct", "Slippage je Order (%)", "number"],
  ]],
  ["Backtest-Mindestwerte", [
    ["backtest.profile", "Prüfmodus", ["strict", "explore", "playbook", "winrate", "final"], "final = 3 feste Strategien aus dem Tageskerzen-Test (mit Zeitrahmen 1d), nur Paper. winrate = 5 feste Strategien mit Trefferquote über 55 % (Testlauf), nur Paper. strict = strenge Mindestwerte (Standard, gilt für Live). explore = stark gelockert. playbook = 5 feste Strategien von trading.de, der Bot wählt die passende (keine Mindestwerte). explore und playbook NUR im Paper-Modus: nicht bewiesen, Verluste wahrscheinlich."],
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
  ["Discord-Meldungen (optional)", [
    ["discord.enabled", "Aktiv", "bool", "Schickt jeden Kauf und Verkauf (mit Stop-Loss, Take-Profit, Gebühren und Begründung) und jede Stunde einen Bericht, warum gekauft oder nicht gekauft wurde."],
    ["discord.webhook", "Webhook-URL", "password", "Discord: Servereinstellungen → Integrationen → Webhooks → URL kopieren. Wird im App-Speicher abgelegt; wer die URL kennt, kann in den Kanal schreiben – nie weitergeben."],    ["discord.liveMessage", "Live-Nachricht im Kanal", "bool", "Eine Nachricht (per Webhook), die sich jede Minute mit der aktuellen Statistik aktualisiert – am besten anpinnen. Sichtbar auf jedem Gerät."],
    ["discord.botToken", "Bot-Token (für die Knöpfe)", "password", "Knöpfe gehen nur mit einem eigenen Discord-Bot (Webhooks können keine): discord.com/developers/applications → New Application → Bot → Token kopieren → unter OAuth2/URL-Generator „bot“ mit Recht „Nachrichten senden“ wählen und den Bot auf deinen Server einladen. Der Token bleibt auf diesem PC."],
    ["discord.channelId", "Kanal-ID (für die Knöpfe)", "text", "In Discord: Einstellungen → Erweitert → Entwicklermodus an; dann Kanal rechtsklicken → „Kanal-ID kopieren“."],
  ]],
  ["Telegram (optional)", [
    ["telegram.enabled", "Aktiv", "bool"],
    ["telegram.token", "Bot-Token", "password", "Wird unverschlüsselt im Browser-Speicher abgelegt."],
    ["telegram.chatId", "Chat-ID", "text"],
  ]],
];

const get = (o, p) => p.split(".").reduce((x, k) => x?.[k], o);
function setPath(o, p, v) { const ks = p.split("."); let x = o; for (const k of ks.slice(0, -1)) x = x[k] ||= {}; x[ks.at(-1)] = v; }
const call = async (type, extra = {}) => { const r = await chrome.runtime.sendMessage({ type, bot: BOT, ...extra }); if (!r?.ok) throw new Error(r?.error); return r.result; };

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
  form.replaceChildren(...(IS_CRYPTO ? [
    h("h2", {}, "Betriebsart"),
    h("label", { class: "check" }, live, h("strong", {}, "LIVE-Modus (echte Orders mit echtem Geld)")),
    h("p", { class: "hint" }, "Ausgeschaltet = Paper-Trading mit Spielgeld. Live erfordert eine angelegte Wallet; getestet sollte zuerst wochenlang im Paper-Modus werden."),
  ] : [
    h("h2", {}, `Bot „${BOTS[BOT].label}“`),
    h("p", { class: "hint" }, "Dieser Bot handelt nur im Paper-Modus (Spielgeld) und teilt sich das Konto mit den anderen beiden Bots. Kursdaten: Yahoo Finance."),
  ]));
  for (const [title, fields] of SECTIONS.filter(([t]) => IS_CRYPTO || !/Solana/.test(t))) {
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
  form.append(h("div", { class: "btns" }, h("button", { class: "btn primary", type: "submit" }, "Speichern"),
    h("button", { class: "btn", type: "button", onclick: async () => {
      try { await call("postDiscordPanel"); const st = await call("discordStatus"); alert(`Panel mit Knöpfen im Kanal gepostet. Bot: ${st.state}${st.error ? " (" + st.error + ")" : ""}. Klick auf „📊 Live-Statistik“ in Discord – auch vom Handy.`); }
      catch (e) { errorBox.textContent = e.message + " (Token und Kanal-ID zuerst speichern.)"; errorBox.hidden = false; }
    } }, "Discord-Knöpfe posten"),
    h("button", { class: "btn", type: "button", onclick: async () => {
      try { await call("testDiscord"); alert("Testnachricht an Discord gesendet."); } catch (e) { errorBox.textContent = e.message + " (Webhook zuerst eintragen und speichern.)"; errorBox.hidden = false; }
    } }, "Discord testen"),
    h("button", { class: "btn danger", type: "button", onclick: async () => {
      if (!confirm("Paper-Konto auf das Startkapital zurücksetzen? Gilt für ALLE Bots und geht nur ohne offene Positionen. Die Trade-Historie bleibt.")) return;
      try { await call("resetAccount"); alert("Paper-Konto zurückgesetzt."); } catch (e) { errorBox.textContent = e.message; errorBox.hidden = false; }
    } }, "Paper-Konto zurücksetzen")));

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
      if (IS_CRYPTO) patch.liveTrading = live.checked;
      if (!assets.length) throw new Error("Mindestens ein Markt muss aktiv sein.");
      patch.assets = assets;
      if (IS_CRYPTO && live.checked && !cfg.liveTrading && prompt('LIVE-Modus aktivieren? Es werden echte Orders mit echtem Geld platziert.\nZur Bestätigung LIVE eintippen:') !== "LIVE") {
        throw new Error("Live-Modus nicht aktiviert (Bestätigung fehlt).");
      }
      for (const url of IS_CRYPTO ? [patch.solana.rpcUrl, patch.solana.jupiterUrl] : []) { // Berechtigung für eigene Hosts anfragen
        const origin = `${new URL(url).origin}/*`;
        if (!(await chrome.permissions.contains({ origins: [origin] })) && !(await chrome.permissions.request({ origins: [origin] }))) {
          throw new Error(`Zugriff auf ${origin} wurde nicht erlaubt.`);
        }
      }
      await call("saveConfig", { patch });
      alert("Gespeichert.");
      document.getElementById("title").textContent = `Trading-Bot – Einstellungen (${BOTS[BOT].label})`;
build();
    } catch (e) { errorBox.textContent = e.message; errorBox.hidden = false; scrollTo(0, 0); }
  };
}

document.getElementById("title").textContent = `Trading-Bot – Einstellungen (${BOTS[BOT].label})`;
build();
