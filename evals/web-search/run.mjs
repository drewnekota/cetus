/**
 * run.mjs — head-to-head eval harness: Tavily vs DeepSeek native web search.
 *
 * For every query in queries.json it calls BOTH providers and records the
 * synthesized answer, the sources returned, latency, and (for DeepSeek) the
 * number of searches the model ran + token usage. Writes two artifacts:
 *   results.json  — full raw + normalized record per query (provider-labeled)
 *   blinded.json  — per-query {answerA, sourcesA, answerB, sourcesB} with the
 *                   A/B→provider mapping stored separately, for blind judging.
 *
 * Keys are read from the dev-secrets file (debug builds store them there).
 * No keys are ever printed. Usage: `node evals/web-search/run.mjs [--only id]`.
 */
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SECRETS = path.join(
  process.env.HOME,
  "Library/Application Support/dev.cetus.app/dev-secrets.json",
);

const keys = JSON.parse(fs.readFileSync(SECRETS, "utf8"));
const TAVILY_KEY = keys.tavily;
const DEEPSEEK_KEY = keys.deepseek;
if (!TAVILY_KEY || !DEEPSEEK_KEY) {
  console.error("Missing tavily or deepseek key in dev-secrets.json");
  process.exit(1);
}

const TIMEOUT_MS = 60_000;
const CONCURRENCY = 4;
const DEEPSEEK_MODEL = "deepseek-v4-pro"; // matches model.rs DsModel::Pro

const onlyId = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1]
  : null;

function ms(t0) {
  return Math.round(performance.now() - t0);
}

async function fetchJson(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON error body */
    }
    return { status: res.status, ok: res.ok, json, text };
  } finally {
    clearTimeout(timer);
  }
}

// --- Tavily: mirrors src-tauri/cetus-extensions/web-search.ts exactly --------
async function tavilySearch(query) {
  const t0 = performance.now();
  try {
    const { status, ok, json, text } = await fetchJson("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TAVILY_KEY}` },
      body: JSON.stringify({
        query,
        max_results: 5,
        search_depth: "basic",
        include_answer: true,
      }),
    });
    const latency_ms = ms(t0);
    if (!ok) return { provider: "tavily", ok: false, latency_ms, error: `HTTP ${status}: ${text.slice(0, 200)}` };
    const results = Array.isArray(json?.results) ? json.results : [];
    return {
      provider: "tavily",
      ok: true,
      latency_ms,
      answer: typeof json?.answer === "string" ? json.answer.trim() : "",
      sources: results.map((r) => ({
        title: String(r?.title || "").trim(),
        url: String(r?.url || ""),
        snippet: String(r?.content || "").replace(/\s+/g, " ").trim().slice(0, 500),
      })),
      num_results: results.length,
      num_searches: 1,
    };
  } catch (e) {
    return { provider: "tavily", ok: false, latency_ms: ms(t0), error: String(e) };
  }
}

// --- DeepSeek native search via Anthropic-compatible /v1/messages -----------
async function deepseekSearch(query) {
  const t0 = performance.now();
  try {
    const { status, ok, json, text } = await fetchJson(
      "https://api.deepseek.com/anthropic/v1/messages",
      {
        method: "POST",
        headers: {
          "x-api-key": DEEPSEEK_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: DEEPSEEK_MODEL,
          max_tokens: 1500,
          messages: [{ role: "user", content: query }],
          tools: [{ type: "web_search_20250305", name: "web_search" }],
        }),
      },
    );
    const latency_ms = ms(t0);
    if (!ok) return { provider: "deepseek", ok: false, latency_ms, error: `HTTP ${status}: ${text.slice(0, 200)}` };

    const blocks = Array.isArray(json?.content) ? json.content : [];
    const answer = blocks
      .filter((b) => b?.type === "text")
      .map((b) => String(b?.text || ""))
      .join("\n")
      .trim();
    const sources = [];
    let num_searches = 0;
    const queries_run = [];
    for (const b of blocks) {
      if (b?.type === "server_tool_use") {
        num_searches++;
        if (b?.input?.query) queries_run.push(String(b.input.query));
      }
      if (b?.type === "web_search_tool_result") {
        const content = Array.isArray(b?.content) ? b.content : [];
        for (const r of content) {
          if (r?.url || r?.title) {
            sources.push({ title: String(r?.title || "").trim(), url: String(r?.url || "") });
          }
        }
      }
    }
    return {
      provider: "deepseek",
      ok: true,
      latency_ms,
      answer,
      sources,
      num_results: sources.length,
      num_searches,
      queries_run,
      stop_reason: json?.stop_reason ?? null,
      usage: json?.usage ?? null,
    };
  } catch (e) {
    return { provider: "deepseek", ok: false, latency_ms: ms(t0), error: String(e) };
  }
}

async function runQuery(q) {
  const [tavily, deepseek] = await Promise.all([tavilySearch(q.query), deepseekSearch(q.query)]);
  const status =
    `${q.id.padEnd(10)} tav ${tavily.ok ? "ok " : "ERR"} ${String(tavily.latency_ms).padStart(5)}ms ` +
    `| ds ${deepseek.ok ? "ok " : "ERR"} ${String(deepseek.latency_ms).padStart(5)}ms ` +
    `searches=${deepseek.num_searches ?? "?"}`;
  console.log(status);
  if (!tavily.ok) console.log(`   tavily error: ${tavily.error}`);
  if (!deepseek.ok) console.log(`   deepseek error: ${deepseek.error}`);
  return { ...q, tavily, deepseek };
}

// Simple concurrency-limited map.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

async function main() {
  let queries = JSON.parse(fs.readFileSync(path.join(HERE, "queries.json"), "utf8"));
  if (onlyId) queries = queries.filter((q) => q.id === onlyId);
  console.log(`Running ${queries.length} queries (concurrency ${CONCURRENCY})…\n`);

  const results = await mapLimit(queries, CONCURRENCY, runQuery);
  fs.writeFileSync(path.join(HERE, "results.json"), JSON.stringify(results, null, 2));

  // Build blinded payload for the judging workflow. Deterministic A/B flip by
  // index parity so the judge can't infer provider from position.
  const blinded = [];
  const mapping = {};
  results.forEach((r, idx) => {
    const dsIsA = idx % 2 === 0;
    const A = dsIsA ? r.deepseek : r.tavily;
    const B = dsIsA ? r.tavily : r.deepseek;
    mapping[r.id] = { A: dsIsA ? "deepseek" : "tavily", B: dsIsA ? "tavily" : "deepseek" };
    blinded.push({
      id: r.id,
      category: r.category,
      lang: r.lang,
      query: r.query,
      answerA: A.ok ? A.answer : `[ERROR: ${A.error}]`,
      sourcesA: (A.sources || []).map((s) => ({ title: s.title, url: s.url })),
      answerB: B.ok ? B.answer : `[ERROR: ${B.error}]`,
      sourcesB: (B.sources || []).map((s) => ({ title: s.title, url: s.url })),
    });
  });
  fs.writeFileSync(path.join(HERE, "blinded.json"), JSON.stringify(blinded, null, 2));
  fs.writeFileSync(path.join(HERE, "mapping.json"), JSON.stringify(mapping, null, 2));

  // Quick aggregate metrics.
  const okT = results.filter((r) => r.tavily.ok);
  const okD = results.filter((r) => r.deepseek.ok);
  const avg = (arr, f) => (arr.length ? Math.round(arr.reduce((s, x) => s + f(x), 0) / arr.length) : 0);
  console.log("\n=== aggregate ===");
  console.log(`tavily   ok ${okT.length}/${results.length}  avg latency ${avg(okT, (r) => r.tavily.latency_ms)}ms  avg sources ${avg(okT, (r) => r.tavily.num_results)}`);
  console.log(`deepseek ok ${okD.length}/${results.length}  avg latency ${avg(okD, (r) => r.deepseek.latency_ms)}ms  avg sources ${avg(okD, (r) => r.deepseek.num_results)}  avg searches ${avg(okD, (r) => r.deepseek.num_searches || 0)}`);
  console.log("\nWrote results.json, blinded.json, mapping.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
