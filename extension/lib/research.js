// Strategie-Recherche per LLM (optional) + Standardstrategien.
// Das LLM liefert nur JSON-Spezifikationen, die gegen feste Typen/Grenzen validiert werden. Es wird nie Code ausgeführt.
// Vorschläge sind nur Kandidaten – zugelassen wird ausschließlich, was der Backtest besteht.
import { buildStrategy, defaultCandidates, describeParamBounds } from "./strategies.js";
import { summarize } from "./indicators.js";

const PROMPT = (cfg, state, n) => `Du bist ein quantitativer Analyst. Recherchiere aus deinem Wissen bekannte, robuste \
Handelsstrategien für Krypto-Spotmärkte (Long-only) auf ${cfg.timeframe}-Kerzen und schlage bis zu ${n} davon mit festen \
Parametern vor. Decke verschiedene Marktphasen ab (uptrend, downtrend, sideways).

Aktueller Marktzustand (SOL/USD): ${state ? summarize(state) : "unbekannt"}

Du darfst AUSSCHLIESSLICH diese Strategietypen mit Parametern innerhalb der Grenzen verwenden:
${describeParamBounds()}

Antworte NUR mit einem JSON-Array, ohne weiteren Text. Jedes Element:
{"type": "<typ>", "params": {...}, "regimes": ["uptrend"|"downtrend"|"sideways", ...], "rationale": "<ein Satz>"}`;

export function parseProposals(text) {
  const start = text.indexOf("["), end = text.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("Keine JSON-Liste in der LLM-Antwort gefunden");
  const raw = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(raw)) throw new Error("LLM-Antwort ist keine Liste");
  const valid = [];
  for (const item of raw) {
    try {
      const spec = buildStrategy(item).toSpec();
      valid.push({ ...spec, source: "llm", rationale: String(item.rationale ?? "").slice(0, 500) });
    } catch (e) {
      console.warn("LLM-Vorschlag verworfen:", e.message);
    }
  }
  return valid;
}

export async function llmCandidates(cfg, state, fetchFn = fetch, n = 6) {
  if (!cfg.llm.apiKey) throw new Error("Kein Anthropic-API-Schlüssel eingetragen");
  const resp = await fetchFn("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": cfg.llm.apiKey, "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify({ model: cfg.llm.model, max_tokens: cfg.llm.maxTokens, messages: [{ role: "user", content: PROMPT(cfg, state, n) }] }),
  });
  if (!resp.ok) throw new Error(`Anthropic HTTP ${resp.status}`);
  const body = await resp.json();
  return parseProposals(body.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
}

export async function collectCandidates(cfg, state, fetchFn = fetch) {
  let candidates = defaultCandidates();
  if (cfg.llm.enabled) {
    try { candidates = candidates.concat(await llmCandidates(cfg, state, fetchFn)); }
    catch (e) { console.warn("LLM-Recherche fehlgeschlagen, nutze nur Standardstrategien:", e.message); }
  }
  const seen = new Set();
  return candidates.filter((s) => {
    const key = JSON.stringify([s.type, s.params, [...s.regimes].sort()]);
    return seen.has(key) ? false : (seen.add(key), true);
  });
}
