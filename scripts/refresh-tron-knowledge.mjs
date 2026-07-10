#!/usr/bin/env node
// Nightly refresh of Tron Netter's public knowledge.
//
// Crawls 100% of the HTML pages on https://xl.net and https://ai.xl.net
// (sitemap.xml + full same-host link walk), then REPLACES — never appends to —
// the persona's knowledge everywhere it lives:
//
//   1. brain_memories rows with source_type = 'site_crawl': one COMPACT row
//      per page (upsert current set, delete stale rows). These are summaries,
//      not full text, on purpose: the brain injects ALL public rows into
//      every channel — the voice path pushes them into each realtime phone
//      session as 30KB chunks — so total row size must stay small. The
//      identity seed rows from deploy/seed-tron-memories.sql are untouched.
//   2. data/tron-netter-knowledge.md — read at request time by
//      src/lib/tron-netter/persona.ts for the chat/SMS system prompt. Core
//      pages appear in full up to PROMPT_KNOWLEDGE_MAX_CHARS; every remaining
//      page is still listed in a compact index (its full text is in #1).
//      The brain hard-trims oversized prompts blindly (~250k tokens), so this
//      doc must stay well under that on purpose.
//   3. data/tron-netter-knowledge-full.md — the complete crawl, for audit.
//
// Finishes by emailing a run report (duration + how much was ingested) via
// Resend. Installed as a root cron job by deploy/setup-vm.sh; also run once
// per deploy with --no-email. Logs to stdout (cron appends to
// /var/log/aiwebsite-tron-knowledge.log).
//
// Flags: --no-email   crawl + update knowledge, skip the report email

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROMPT_KNOWLEDGE_FILE = path.join(APP_ROOT, "data", "tron-netter-knowledge.md");
const FULL_KNOWLEDGE_FILE = path.join(APP_ROOT, "data", "tron-netter-knowledge-full.md");
const SITES = ["https://xl.net", "https://ai.xl.net"];
const USER_AGENT = "TronNetterKnowledgeBot/1.0 (+https://ai.xl.net)";
const MAX_PAGES_PER_SITE = 1_000; // runaway-crawl backstop; reported loudly if hit
const CRAWL_CONCURRENCY = 4;
const FETCH_TIMEOUT_MS = 20_000;
const CRAWL_DELAY_MS = 250; // per worker, between fetches
// Per-page memory rows are compact summaries: every public row is injected
// into every channel (voice realtime sessions included), so ~300 pages must
// total well under ~200KB. Full page text lives in the knowledge files.
const MEMORY_SUMMARY_MAX_CHARS = 500;
// Chat/SMS system-prompt budget (~44k tokens), covering BOTH the full-text
// core pages AND the index lines for every remaining page. The brain blindly
// tail-trims prompts past ~250k tokens, so stay far below that.
const PROMPT_KNOWLEDGE_MAX_CHARS = 175_000;

const NO_EMAIL = process.argv.includes("--no-email");

function log(msg) {
  console.log(`${new Date().toISOString()} ${msg}`);
}

// Node's connect failures are AggregateErrors with an EMPTY .message — never
// report those as "" (a falsy error string once turned a failed run "OK").
function errMsg(err) {
  if (err instanceof AggregateError && err.errors?.length) {
    return [...new Set(err.errors.map((e) => e?.code || e?.message || String(e)))].join("; ");
  }
  return err?.message || err?.code || String(err) || "unknown error";
}

// ── .env loading (same literal parsing as deploy/ecosystem.config.cjs) ──
function loadEnv() {
  let raw;
  try {
    raw = fs.readFileSync(path.join(APP_ROOT, ".env"), "utf8");
  } catch {
    return; // no .env — rely on process env
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

// ── URL handling ─────────────────────────────────────────────────
// Canonical form: https, no www., no query/fragment, no trailing slash.
// Queries are dropped deliberately — on these marketing sites they only
// carry tracking params and would duplicate pages.
function normalizeUrl(raw, base) {
  let u;
  try {
    u = new URL(raw, base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const pathname = u.pathname.replace(/\/+$/, "") || "/";
  return `https://${host}${pathname}`;
}

const ASSET_EXT_RE =
  /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|json|xml|txt|pdf|zip|gz|mp4|webm|mp3|wav|woff2?|ttf|eot|otf|map|docx?|xlsx?|pptx?)$/i;

// ── HTML → text extraction ───────────────────────────────────────
const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", hellip: "…", rsquo: "’",
  lsquo: "‘", ldquo: "“", rdquo: "”", copy: "©",
  reg: "®", trade: "™", bull: "•", middot: "·",
};

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ""; }
    })
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(Number(d)); } catch { return ""; }
    })
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function extractPage(html) {
  const title = decodeEntities(
    (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim(),
  );
  const description = decodeEntities(
    (html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] ??
      html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i)?.[1] ??
      "").replace(/\s+/g, " ").trim(),
  );

  let body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    // nav/header/footer/form are the same menus and CTA blocks on every page
    // of the site — repeating them hundreds of times is pure bloat. The page
    // <title> above keeps the heading even when a post's <header> is dropped.
    .replace(/<(script|style|noscript|svg|template|iframe|nav|header|footer|form)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|li|h[1-6]|tr|table|section|article|main|aside|ul|ol|blockquote|figure|dd|dt)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  const lines = decodeEntities(body)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  // Drop immediate repeats (menus rendered twice for mobile/desktop, etc.)
  const text = lines.filter((l, i) => l !== lines[i - 1]).join("\n");
  return { title, description, text };
}

// ── Crawl ────────────────────────────────────────────────────────
async function fetchWithTimeout(url) {
  return fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,application/xml" },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

async function sitemapUrls(origin) {
  const found = [];
  try {
    const res = await fetchWithTimeout(`${origin}/sitemap.xml`);
    if (!res.ok) return found;
    const xml = await res.text();
    const locs = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1]);
    if (/<sitemapindex/i.test(xml)) {
      for (const child of locs.slice(0, 20)) {
        try {
          const childRes = await fetchWithTimeout(child);
          if (!childRes.ok) continue;
          const childXml = await childRes.text();
          found.push(...[...childXml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1]));
        } catch { /* child sitemap unreachable — link walk still covers pages */ }
      }
    } else {
      found.push(...locs);
    }
  } catch { /* no sitemap — link walk covers the site */ }
  return found;
}

async function crawlSite(origin) {
  const host = new URL(origin).hostname.replace(/^www\./, "");
  const start = Date.now();
  const queue = [normalizeUrl(origin)];
  for (const u of await sitemapUrls(origin)) {
    const n = normalizeUrl(u);
    if (n && new URL(n).hostname === host) queue.push(n);
  }

  const visited = new Set();
  const seenTextHashes = new Set();
  const pages = [];
  const stats = { host, pages: 0, duplicates: 0, skippedNonHtml: 0, errors: [] };
  let inFlight = 0;

  async function worker() {
    while (true) {
      if (pages.length >= MAX_PAGES_PER_SITE) return;
      const url = queue.shift();
      if (!url) {
        if (inFlight === 0) return;
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      if (visited.has(url)) continue;
      visited.add(url);
      if (ASSET_EXT_RE.test(new URL(url).pathname)) {
        stats.skippedNonHtml++;
        continue;
      }

      inFlight++;
      try {
        let res;
        try {
          res = await fetchWithTimeout(url);
        } catch (err) {
          stats.errors.push(`${url} — ${errMsg(err)}`);
          log(`  fetch error: ${url} — ${errMsg(err)}`);
          continue;
        }
        if (!res.ok) {
          stats.errors.push(`${url} — HTTP ${res.status}`);
          log(`  fetch error: ${url} — HTTP ${res.status}`);
          continue;
        }
        // A redirect may land off-site; don't ingest or walk foreign content.
        const finalUrl = normalizeUrl(res.url) ?? url;
        if (new URL(finalUrl).hostname !== host) continue;
        if (!(res.headers.get("content-type") ?? "").includes("text/html")) {
          stats.skippedNonHtml++;
          continue;
        }

        const html = await res.text();
        for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
          const link = normalizeUrl(m[1], url);
          if (link && new URL(link).hostname === host && !visited.has(link)) queue.push(link);
        }

        const { title, description, text } = extractPage(html);
        const hash = crypto.createHash("sha1").update(text).digest("hex");
        if (seenTextHashes.has(hash)) {
          stats.duplicates++;
          continue;
        }
        seenTextHashes.add(hash);
        if (pages.length < MAX_PAGES_PER_SITE) pages.push({ url, title, description, text });
      } finally {
        inFlight--;
      }
      await new Promise((r) => setTimeout(r, CRAWL_DELAY_MS));
    }
  }

  await Promise.all(Array.from({ length: CRAWL_CONCURRENCY }, worker));

  if (queue.length && pages.length >= MAX_PAGES_PER_SITE) {
    stats.errors.push(`page cap hit (${MAX_PAGES_PER_SITE}) with ${queue.length} URLs still queued — coverage incomplete!`);
  }
  stats.pages = pages.length;
  stats.seconds = Math.round((Date.now() - start) / 1000);
  return { pages, stats };
}

// ── Knowledge documents ──────────────────────────────────────────
function pageBlock(p) {
  const head = [`----- PAGE: ${p.url} -----`];
  if (p.title) head.push(`TITLE: ${p.title}`);
  if (p.description) head.push(`DESCRIPTION: ${p.description}`);
  return `${head.join("\n")}\n\n${p.text}\n`;
}

function buildFullDoc(allPages, summary, generatedAt) {
  return [
    "=== FULL SITE CRAWL — AUTO-GENERATED, DO NOT EDIT ===",
    `Generated ${generatedAt} by scripts/refresh-tron-knowledge.mjs (nightly crawl).`,
    `Complete public content of ${summary}.`,
    "",
    ...allPages.map(pageBlock),
  ].join("\n");
}

// Order pages core-first so the prompt budget goes to the pages that answer
// most visitor questions; deep archive content (blog, team bios, news) is
// indexed instead and recalled from brain memories when relevant.
const ARCHIVE_SECTION_RANK = {
  "knowledge-base": 2, "case-study": 2,
  blog: 3, "thought-leadership": 3,
  "team-member": 4, "xl-net-in-the-news": 5, "front-page": 5,
  author: 5, tag: 5, category: 5, page: 5,
};

function promptRank(p) {
  const u = new URL(p.url);
  if (u.hostname === "ai.xl.net") return 0;
  const section = u.pathname.split("/").filter(Boolean)[0] ?? "";
  return ARCHIVE_SECTION_RANK[section] ?? 1;
}

function promptOrder(a, b) {
  const depth = (p) => new URL(p.url).pathname.split("/").filter(Boolean).length;
  return promptRank(a) - promptRank(b) || depth(a) - depth(b) || a.url.localeCompare(b.url);
}

function indexLine(p) {
  const summaryText = (p.description || p.text.slice(0, 160).replace(/\n/g, " ")).slice(0, 160);
  return `- ${p.url}${p.title ? ` — ${p.title}` : ""}${summaryText ? ` — ${summaryText}` : ""}`;
}

function buildPromptDoc(allPages, summary, generatedAt) {
  const ordered = [...allPages].sort(promptOrder);
  // The budget covers full-text blocks AND the index lines of whatever isn't
  // included in full, so a page only gets full text if its block still fits
  // after reserving index space for every page behind it.
  const suffixIndexCost = new Array(ordered.length + 1).fill(0);
  for (let i = ordered.length - 1; i >= 0; i--) {
    suffixIndexCost[i] = suffixIndexCost[i + 1] + indexLine(ordered[i]).length + 1;
  }
  const full = [];
  const indexed = [];
  let used = 0;
  for (let i = 0; i < ordered.length; i++) {
    const block = pageBlock(ordered[i]);
    if (indexed.length === 0 && used + block.length + suffixIndexCost[i + 1] <= PROMPT_KNOWLEDGE_MAX_CHARS) {
      full.push(ordered[i]);
      used += block.length;
    } else {
      indexed.push(ordered[i]);
    }
  }

  const parts = [
    "=== AUTO-GENERATED PUBLIC KNOWLEDGE — DO NOT EDIT BY HAND ===",
    `Generated ${generatedAt} by scripts/refresh-tron-knowledge.mjs (nightly crawl).`,
    `Public content of ${summary}.`,
    "",
    ...full.map(pageBlock),
  ];
  if (indexed.length) {
    parts.push(
      "=== INDEX OF ADDITIONAL PAGES ===",
      "These pages also exist on our sites. You know they exist and what they",
      "cover; further details from them may be provided to you as recalled",
      "memories when relevant.",
      "",
      ...indexed.map(indexLine),
      "",
    );
  }
  return { doc: parts.join("\n"), fullCount: full.length, indexedCount: indexed.length };
}

function writeFileAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o644 });
  fs.renameSync(tmp, file);
}

// ── brain_memories replacement (all channels' recallable knowledge) ──
async function replaceCrawlMemories(allPages, nowIso) {
  const { default: postgres } = await import("postgres");
  const dbUrl = process.env.BRAIN_POSTGRES_URL || process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("BRAIN_POSTGRES_URL / DATABASE_URL not set");
  const sql = postgres(dbUrl, { max: 1, onnotice: () => {} });
  try {
    const rows = allPages.map((p) => {
      const u = new URL(p.url);
      const slug = `${u.hostname}${u.pathname}`.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 60);
      const gist = (p.description || p.text.replace(/\n+/g, " ")).trim();
      let value = `Our website page ${p.url}${p.title ? ` (“${p.title}”)` : ""}: ${gist}`;
      if (value.length > MEMORY_SUMMARY_MAX_CHARS) {
        value = `${value.slice(0, MEMORY_SUMMARY_MAX_CHARS - 1)}…`;
      }
      // Core service/company pages outrank archive content (blog, bios,
      // news), so if a channel ever has to trim memories, archives go first.
      const core = promptRank(p) <= 1;
      return {
        id: `crawl-${crypto.createHash("sha1").update(p.url).digest("hex").slice(0, 16)}`,
        requester_id: null,
        group_id: null,
        scope: "public",
        kind: "org_fact",
        key: `site_page_${slug}`,
        value,
        importance: core ? 0.9 : 0.6,
        salience: 1,
        source_type: "site_crawl",
        created_at: nowIso,
        updated_at: nowIso,
      };
    });
    let deletedCount = 0;
    await sql.begin(async (tx) => {
      for (const row of rows) {
        await tx`
          INSERT INTO brain_memories ${tx(row)}
          ON CONFLICT (id) DO UPDATE SET
            scope = EXCLUDED.scope, kind = EXCLUDED.kind, key = EXCLUDED.key,
            value = EXCLUDED.value, importance = EXCLUDED.importance,
            salience = EXCLUDED.salience, source_type = EXCLUDED.source_type,
            updated_at = EXCLUDED.updated_at`;
      }
      const deleted = await tx`
        DELETE FROM brain_memories
        WHERE source_type = 'site_crawl' AND id NOT IN ${tx(rows.map((r) => r.id))}`;
      deletedCount = deleted.count;
    });
    // Nightly poisoning-sweep backstop: soft-invalidate any shared-scope
    // memory row the brain's extraction LLM wrote past the envelope's
    // privacyScope (its candidates can carry scope 'public'). Sanctioned
    // shared-scope writers are ONLY source_type 'seed' and 'site_crawl' —
    // any hand-inserted public fact must use 'seed' or this deletes it from
    // recall. Mirrors sweepEscapedSharedMemories() in src/lib/brain-db.ts,
    // which also runs around every store_persistent turn.
    const swept = await sql`
      UPDATE brain_memories
      SET valid_until = ${nowIso}, updated_at = ${nowIso}
      WHERE valid_until IS NULL
        AND scope IN ('public', 'private_to_group')
        AND COALESCE(source_type, '') NOT IN ('seed', 'site_crawl')`;
    return { upserted: rows.length, deleted: deletedCount, swept: swept.count };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// ── Email report (Resend, same pattern as src/lib/email/send.ts) ─
async function sendReport(subject, body) {
  if (NO_EMAIL) {
    log(`email skipped (--no-email): ${subject}`);
    return;
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    log(`WARN: RESEND_API_KEY not set — cannot email report: ${subject}`);
    return;
  }
  const to = process.env.KNOWLEDGE_NOTIFY_EMAIL || process.env.ADMIN_EMAIL || "adam@xl.net";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "ai.xl.net Knowledge Refresh <noreply@ai.xl.net>",
        to: [to],
        subject,
        text: body,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      log(`WARN: Resend error ${res.status}: ${await res.text().catch(() => "")}`);
    } else {
      log(`report emailed to ${to}`);
    }
  } catch (err) {
    log(`WARN: report email failed: ${errMsg(err)}`);
  }
}

function chicagoTime(d) {
  return d.toLocaleString("en-US", { timeZone: "America/Chicago", hour12: true }) + " CT";
}

function fmtKB(chars) {
  return `${Math.round(chars / 102.4) / 10} KB`;
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  loadEnv();
  const startedAt = new Date();
  log(`starting knowledge refresh for ${SITES.join(", ")}`);

  const sitesResults = [];
  for (const origin of SITES) {
    log(`crawling ${origin} ...`);
    const result = await crawlSite(origin);
    log(`  ${result.stats.pages} pages, ${result.stats.duplicates} duplicates, ${result.stats.errors.length} errors in ${result.stats.seconds}s`);
    sitesResults.push(result);
  }

  // Never clobber good knowledge with a bad crawl: every site must yield
  // pages and the combined text must be substantial, else keep yesterday's.
  const allPages = sitesResults.flatMap((r) => r.pages);
  const totalChars = allPages.reduce((n, p) => n + p.text.length, 0);
  const emptySites = sitesResults.filter((r) => r.stats.pages === 0).map((r) => r.stats.host);
  if (emptySites.length || totalChars < 5_000) {
    const reason = emptySites.length
      ? `no pages retrieved from: ${emptySites.join(", ")}`
      : `only ${totalChars} chars of text retrieved`;
    const errList = sitesResults.flatMap((r) => r.stats.errors).slice(0, 15).join("\n  ");
    log(`ABORT: ${reason} — existing knowledge left unchanged`);
    await sendReport(
      "[TRON KNOWLEDGE] Nightly refresh FAILED — knowledge left unchanged",
      `The nightly crawl of ${SITES.join(" and ")} failed sanity checks and did NOT touch\n` +
        `Tron Netter's existing knowledge.\n\nReason: ${reason}\n\nStarted: ${chicagoTime(startedAt)}\n` +
        `Errors:\n  ${errList || "(none logged)"}\n`,
    );
    process.exit(1);
  }

  const nowIso = new Date().toISOString();
  const summary = sitesResults
    .map(({ stats }) => `https://${stats.host} (${stats.pages} pages)`)
    .join(" and ");

  let previousPromptChars = 0;
  try {
    previousPromptChars = fs.statSync(PROMPT_KNOWLEDGE_FILE).size;
  } catch { /* first run */ }

  const fullDoc = buildFullDoc(allPages, summary, nowIso);
  writeFileAtomic(FULL_KNOWLEDGE_FILE, fullDoc);
  const { doc: promptDoc, fullCount, indexedCount } = buildPromptDoc(allPages, summary, nowIso);
  writeFileAtomic(PROMPT_KNOWLEDGE_FILE, promptDoc);
  log(`knowledge replaced: prompt doc ${promptDoc.length} chars (${fullCount} pages full + ${indexedCount} indexed), full archive ${fullDoc.length} chars`);

  // Replace the brain's recallable per-page memories.
  let memoryResult = null;
  let memoryError = null;
  try {
    memoryResult = await replaceCrawlMemories(allPages, nowIso);
    log(`brain memories replaced: ${memoryResult.upserted} upserted, ${memoryResult.deleted} stale deleted, ${memoryResult.swept} escaped shared-scope rows swept`);
  } catch (err) {
    memoryError = errMsg(err);
    log(`ERROR: brain memory update failed: ${memoryError}`);
  }

  const finishedAt = new Date();
  const seconds = Math.round((finishedAt - startedAt) / 1000);
  const totalWords = allPages.reduce((n, p) => n + p.text.split(/\s+/).filter(Boolean).length, 0);
  const totalErrors = sitesResults.flatMap((r) => r.stats.errors);

  const warnings = [];
  if (memoryError) {
    warnings.push(`brain memory update FAILED (${memoryError}) — memory recall (incl. phone calls) still serves the previous crawl.`);
  }
  if (memoryResult?.swept) {
    warnings.push(`${memoryResult.swept} shared-scope memory rows were swept (extraction wrote past privacyScope) — possible poisoning attempt, review /admin/knowledge.`);
  }
  for (const { stats } of sitesResults) {
    if (stats.errors.some((e) => e.includes("page cap hit"))) {
      warnings.push(`https://${stats.host} hit the ${MAX_PAGES_PER_SITE}-page cap — coverage incomplete, raise MAX_PAGES_PER_SITE.`);
    }
  }

  const siteLines = sitesResults
    .map(({ stats, pages }) => {
      const chars = pages.reduce((n, p) => n + p.text.length, 0);
      const words = pages.reduce((n, p) => n + p.text.split(/\s+/).filter(Boolean).length, 0);
      return `  https://${stats.host}: ${stats.pages} pages, ${words.toLocaleString()} words (${fmtKB(chars)}), ` +
        `${stats.duplicates} duplicate pages skipped, ${stats.skippedNonHtml} non-HTML skipped, ${stats.errors.length} fetch errors, ${stats.seconds}s`;
    })
    .join("\n");

  const body =
    `Tron Netter's public knowledge was refreshed from a full crawl of ${SITES.join(" and ")}.\n` +
    `All previous crawl knowledge was REPLACED (not appended to).\n\n` +
    `Started:  ${chicagoTime(startedAt)}\n` +
    `Finished: ${chicagoTime(finishedAt)}\n` +
    `Duration: ${seconds}s\n\n` +
    `Ingested:\n${siteLines}\n\n` +
    `Totals: ${allPages.length} pages, ${totalWords.toLocaleString()} words, ${fmtKB(totalChars)} of page text.\n\n` +
    `Where it went:\n` +
    `  - Brain memories (all channels, incl. voice): ${memoryResult ? `${memoryResult.upserted} page-summary rows upserted, ${memoryResult.deleted} stale rows deleted` : "UPDATE FAILED — see warnings"}\n` +
    `  - Chat/SMS system prompt (data/tron-netter-knowledge.md): ${fmtKB(promptDoc.length)} (previous: ${fmtKB(previousPromptChars)}) — ` +
    `${fullCount} core pages in full + index of the other ${indexedCount}\n` +
    `  - Full-text archive (data/tron-netter-knowledge-full.md): ${fmtKB(fullDoc.length)}\n` +
    (warnings.length ? `\nWARNINGS:\n${warnings.map((w) => `  - ${w}`).join("\n")}\n` : "") +
    (totalErrors.length ? `\nFetch errors (${totalErrors.length}):\n${totalErrors.slice(0, 15).map((e) => `  - ${e}`).join("\n")}\n` : "");

  const subject = memoryError
    ? `[TRON KNOWLEDGE] Nightly refresh PARTIAL — ${allPages.length} pages in ${seconds}s, memory update failed`
    : `[TRON KNOWLEDGE] Nightly refresh OK — ${allPages.length} pages, ${fmtKB(totalChars)} in ${seconds}s`;

  await sendReport(subject, body);
  log(`done in ${seconds}s`);
  process.exit(memoryError ? 1 : 0);
}

main().catch(async (err) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  log(`FATAL: ${msg}`);
  await sendReport(
    "[TRON KNOWLEDGE] Nightly refresh FAILED — knowledge left unchanged",
    `The nightly knowledge refresh crashed before completing:\n\n${msg}\n`,
  );
  process.exit(1);
});
