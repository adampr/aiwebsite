#!/usr/bin/env node
// Pre-fetch the day's AI news for the blog engine's topic steering.
//
// The module's nightly job picks its topic BEFORE dataSource.getContext runs
// (aicompany §19.5/§19.6: calendar → strategist, neither sees live data), so
// something must land today's top story where site.config.ts can read it
// synchronously. This script writes data/ai-news-today.json:
//
//   { fetchedAt, top: { slug, title, keywords, description, url },
//     headlines: [{ title, url, snippet, score }] }
//
// src/lib/blog/news.ts turns `top` into a one-entry topics.calendar and
// `headlines` into topics.seedHints.news (strategist fallback), and triggers
// this script from the blog-nightly process when the file is missing/stale.
// data/ is VM-generated (gitignored, rsync-excluded) — the right home.
//
// Usage: node scripts/fetch-ai-news.mjs [--env /path/to/.env]
// Exit code: 0 = file written, 1 = fetch failed (stale file left in place;
// the calendar layer degrades to strategist-with-stale-hints, and the
// dataSource still fetches live facts at generate time).
//
// No SDKs on purpose: plain fetch, so it runs anywhere Node 18+ does.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const envFlagIdx = argv.indexOf("--env");
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const ENV_PATH = envFlagIdx >= 0 ? argv[envFlagIdx + 1] : path.resolve(repoRoot, ".env");

const env = {};
try {
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  // .env optional — TAVILY_API_KEY may arrive via process env (vitest, CI).
}

const TAVILY_API_KEY = process.env.TAVILY_API_KEY || env.TAVILY_API_KEY || "";
const OUT_PATH = path.resolve(repoRoot, "data", "ai-news-today.json");
const TIMEOUT_MS = 30_000;

if (!TAVILY_API_KEY) {
  console.error("FATAL: TAVILY_API_KEY not set (env or .env)");
  process.exit(1);
}

/** One retry after 500 ms, mirroring the brain skills-host web_search shape. */
async function tavilySearch(body) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: TAVILY_API_KEY, ...body }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`tavily ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return await res.json();
    } catch (err) {
      if (attempt >= 1) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/** News APIs return "Headline - Publisher" / "Headline | Publisher" titles. */
function cleanTitle(raw) {
  const t = raw.trim();
  const m = t.match(/^(.{20,}?)\s+[-–—|]\s+[A-Z][\w.]*(?:\s+[A-Z][\w.]*){0,3}$/);
  return (m ? m[1] : t).trim();
}

const STOPWORDS = new Set(
  ("a an and are as at be but by for from has have how in is it its new of on or say says " +
    "she he that the their this to was were what when who why will with you your").split(" "),
);

function slugify(s, maxLen = 60) {
  const slug = s
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/, "");
  return slug || "ai-news";
}

/** keywords[0] = primary keyword (must read naturally in the title). */
function keywordsFromTitle(title) {
  const tokens = title
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !STOPWORDS.has(t.toLowerCase()));
  // Primary: the first run of 2-3 significant tokens — for news headlines that
  // is almost always the acting entity + subject ("OpenAI GPT-6", "EU AI Act").
  const primary = tokens.slice(0, Math.min(3, tokens.length)).join(" ").toLowerCase();
  const rest = tokens
    .slice(3)
    .map((t) => t.toLowerCase())
    .filter((t, i, a) => t.length > 2 && a.indexOf(t) === i)
    .slice(0, 4);
  return [primary, ...rest].filter(Boolean).slice(0, 5);
}

// The top result becomes the article's title/slug verbatim and the rest feed
// the strategist, so a non-AI story here gets PUBLISHED (2026-07-14: a generic
// "Technology and Science News - ABC News" outlet page outscored every real AI
// headline). Gate on the cleaned title — not content, which mentions AI in
// passing on generic roundup pages.
const AI_RELEVANT =
  /\b(?:ai|a\.i\.|artificial intelligence|machine[- ]learning|deep[- ]learning|neural net(?:work)?s?|llms?|large language models?|gen(?:erative)?[ -]?ai|chatbots?|chatgpt|gpt-?\d\w*|openai|anthropic|claude|gemini|copilot|deepmind|agi|superintelligen\w+|agentic|grok|xai|llama|mistral|hugging face|foundation models?)\b/i;

const query =
  "most significant artificial intelligence news today: model releases, " +
  "AI regulation, enterprise AI adoption, AI security incidents";

const data = await tavilySearch({
  query,
  topic: "news",
  days: 1,
  max_results: 10,
  search_depth: "advanced",
}).catch((err) => {
  console.error(`FATAL: news fetch failed: ${err.message}`);
  process.exit(1);
});

const fetched = (data.results || [])
  .filter((r) => r && r.title && r.url)
  .map((r) => ({ ...r, title: cleanTitle(r.title) }))
  .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

const results = fetched.filter((r) => AI_RELEVANT.test(r.title));
for (const r of fetched) {
  if (!results.includes(r)) console.error(`skipped (title not AI-relevant): "${r.title}"`);
}

if (results.length === 0) {
  console.error(`FATAL: no AI-relevant results (tavily returned ${fetched.length})`);
  process.exit(1);
}

const now = new Date();
const dateStamp = now.toISOString().slice(0, 10);
const top = results[0];
const payload = {
  fetchedAt: now.toISOString(),
  top: {
    slug: `${slugify(top.title)}-${dateStamp}`,
    title: top.title.trim(),
    keywords: keywordsFromTitle(top.title),
    description: (top.content || "").replace(/\s+/g, " ").trim().slice(0, 240),
    url: top.url,
  },
  headlines: results.map((r) => ({
    title: r.title.trim(),
    url: r.url,
    snippet: (r.content || "").replace(/\s+/g, " ").trim().slice(0, 240),
    score: r.score ?? null,
  })),
};

// Atomic write (tmp+rename, 0644) — same discipline as the knowledge crawl.
fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
const tmp = `${OUT_PATH}.tmp`;
fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o644 });
fs.renameSync(tmp, OUT_PATH);
console.log(`wrote ${OUT_PATH}: top="${payload.top.title}" (+${payload.headlines.length - 1} more)`);
