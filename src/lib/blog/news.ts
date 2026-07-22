// AI-news topic steering + dataSource for the blog engine (aicompany §19.6).
//
// The module's nightly job fixes its topic BEFORE dataSource.getContext runs:
// calendar first, then the strategist — and neither sees live data. Daily news
// therefore flows in two stages, both fed by scripts/fetch-ai-news.mjs writing
// data/ai-news-today.json:
//
//   1. Topic:  newsCalendarEntries() turns today's top story into a one-entry
//      topics.calendar (slug carries the date, so yesterday's consumed entry
//      never blocks today's — consumption is slug-existence in blog_posts).
//      newsSeedHints() gives the strategist today's other headlines as the
//      fallback when the calendar entry is rejected (e.g. same story topped
//      two days running and trigram dedup fires).
//   2. Facts:  newsDataProvider.getContext() searches Tavily live for the
//      chosen story and builds the factSheet; a throw here is the module's
//      sanctioned WARN-skip path (§19.5).
//
// site.config.ts is re-imported by tsx on every nightly run, so the
// module-scope prefetch below refreshes the file nightly. It fires only in
// the blog-nightly process (systemd timer AND admin Run-now both spawn
// scripts/blog-nightly.ts) — never in Next, config:check, or vitest.
//
// RUNTIME CONSTRAINT: site.config.ts is also bundled for the Edge middleware,
// where node builtins may not even be imported. Everything node-flavored here
// therefore goes through process.getBuiltinModule (Node ≥20.16; undefined on
// Edge, invisible to the bundler) and degrades to "no steering" — the blog
// job itself always runs under real Node via tsx.

import type { BlogDataContext, BlogDataProvider } from "@aicompany/core/config/types";

type FsMod = typeof import("node:fs");

// site.config.ts calls newsCalendarEntries()/newsSeedHints() at module scope,
// and site.config is imported by the Edge middleware — so this file is
// evaluated in the Edge Runtime too. Edge bans node builtins AND throws on any
// reference to `process.getBuiltinModule`. Next sets the global `EdgeRuntime`
// there, so we detect it first and never touch process at all on Edge; the
// blog steering functions then return their empty/default shapes (correct —
// the middleware has no use for blog topics). Under Node (server + the tsx
// job) getBuiltinModule (≥20.16) loads fs/path/child_process on demand,
// keeping the static bundler from following a top-level `import "node:fs"`.
const IS_EDGE = typeof (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime !== "undefined";

function nodeProcess(): (NodeJS.Process & { getBuiltinModule?: (id: string) => unknown }) | null {
  if (IS_EDGE) return null;
  const p = (globalThis as Record<string, unknown>).process as NodeJS.Process | undefined;
  return p && typeof p.cwd === "function" ? p : null;
}

function builtin<T>(id: string): T | null {
  const p = nodeProcess();
  if (!p) return null;
  const get = p.getBuiltinModule as ((id: string) => unknown) | undefined;
  return typeof get === "function" ? ((get.call(p, id) as T) ?? null) : null;
}

const NEWS_REL = ["data", "ai-news-today.json"];
const FETCH_REL = ["scripts", "fetch-ai-news.mjs"];
const STEER_MAX_AGE_H = 36; // beyond this the file no longer steers topics
const REFETCH_AFTER_H = 20; // nightly cadence with slack for manual run-nows

interface NewsFile {
  fetchedAt: string;
  top: {
    slug: string;
    title: string;
    keywords: string[];
    description: string;
    url: string;
    /** Peg verdict from scripts/lib/peg-score.mjs; absent in pre-peg files
     *  (transition tolerance — an old file must still steer). */
    peg?: { score: number; pegless: boolean };
  };
  headlines: {
    title: string;
    url: string;
    snippet: string;
    score: number | null;
    /** Absent in pre-peg files. */
    pegScore?: number;
  }[];
}

/**
 * Report-of-record framing, appended to the calendar entry's description
 * (which reaches the writer verbatim as "Brief:") when the day's best story
 * is peg-less — the voiceAdherence fix at the source: the peg IS the release.
 * NOTE: this text flows into checkTopic's offLimits/protectedKeywords
 * haystack (topics.ts) — keep the wording neutral; this host has offLimits []
 * and no protected keyword overlaps (pinned by scripts/peg-score-tests.mjs).
 */
const REPORT_OF_RECORD_BRIEF =
  " FRAMING (report-of-record): this story has no external dated event; the " +
  "news peg is the RELEASE of the survey/report itself. The dated lede names " +
  "the publishing organization, what it published, and the release date; the " +
  "article reports the findings with inline attribution. Do not editorialize " +
  "the trend outside the closing take section.";

function ageHours(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (Date.now() - t) / 3_600_000 : Infinity;
}

function readNewsFile(): NewsFile | null {
  const proc = nodeProcess();
  const fs = builtin<FsMod>("node:fs");
  const path = builtin<typeof import("node:path")>("node:path");
  if (!proc || !fs || !path) return null;
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.resolve(proc.cwd(), ...NEWS_REL), "utf8"),
    ) as NewsFile;
    return parsed?.top?.slug && parsed?.top?.title ? parsed : null;
  } catch {
    return null;
  }
}

export function loadTodaysNews(): NewsFile | null {
  const parsed = readNewsFile();
  return parsed && ageHours(parsed.fetchedAt) <= STEER_MAX_AGE_H ? parsed : null;
}

// Guarded prefetch: blog-nightly context only, and only when missing/stale.
// Failure is non-fatal by design — the fallback chain below degrades cleanly.
{
  const proc = nodeProcess();
  if (proc && (proc.argv?.[1] ?? "").endsWith("blog-nightly.ts")) {
    const cp = builtin<typeof import("node:child_process")>("node:child_process");
    const path = builtin<typeof import("node:path")>("node:path");
    const existing = readNewsFile();
    if (cp && path && (!existing || ageHours(existing.fetchedAt) > REFETCH_AFTER_H)) {
      try {
        cp.execFileSync(proc.execPath, [path.resolve(proc.cwd(), ...FETCH_REL)], {
          timeout: 120_000,
          stdio: "inherit",
        });
      } catch (err) {
        console.error(
          `[blog/news] prefetch failed (continuing): ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }
}

/** Monday-based ISO week number — reporting metadata only (§19.6). */
function isoWeek(d: Date): number {
  const u = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  u.setUTCDate(u.getUTCDate() + 4 - (u.getUTCDay() || 7));
  const yearStart = Date.UTC(u.getUTCFullYear(), 0, 1);
  return Math.ceil(((u.getTime() - yearStart) / 86_400_000 + 1) / 7);
}

/** Today's top story as a one-entry calendar; [] when no fresh file. */
export function newsCalendarEntries(): {
  week: number;
  type: string;
  slug: string;
  title: string;
  keywords: string[];
  description: string;
}[] {
  const news = loadTodaysNews();
  if (!news) return [];
  return [
    {
      week: isoWeek(new Date()),
      type: "news",
      slug: news.top.slug,
      title: news.top.title,
      keywords: news.top.keywords,
      description:
        news.top.description + (news.top.peg?.pegless ? REPORT_OF_RECORD_BRIEF : ""),
    },
  ];
}

/** Today's other headlines for the strategist; evergreen angles when stale.
 *  Peg-less headlines (pegScore < 0) are annotated so the strategist knows
 *  they need report-of-record framing; the list arrives pegged-first (the
 *  fetcher already sorts by pegScore). */
export function newsSeedHints(): string[] {
  const news = loadTodaysNews();
  if (news) {
    return news.headlines.slice(0, 8).map((h) =>
      (h.pegScore ?? 0) < 0
        ? `${h.title} [no dated news peg — usable only framed as a report-of-record: lede names the publisher and the release date]`
        : h.title,
    );
  }
  return [
    "What this week's most consequential AI release means for small businesses",
    "An AI regulation development and what it changes for US companies",
    "A real AI security incident and the operational lesson in it",
  ];
}

const TAVILY_TIMEOUT_MS = 30_000;
const SOURCE_BODY_MAX = 2500;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "Thu, 18 Jun 2026 09:10:07 GMT" → "June 18, 2026"; unparseable → null. */
function formatSourceDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

function sourceAgeDays(raw: string | undefined): number | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86_400_000) : null;
}

/** Citable outlet label from a source URL: hostname without "www.". */
function outletFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Cut text at a sentence boundary within `max` chars (word boundary as
 * fallback, hard cut as last resort) so fact-sheet sources never end
 * mid-claim — the fact-check gate fails articles that echo truncated facts.
 * Mirrors the sentence-accumulation pattern in @aicompany/core
 * src/blog/render.ts (tldrDescription).
 */
function truncateAtSentence(text: string, max = SOURCE_BODY_MAX): string {
  if (text.length <= max) return text;
  const sentences = text.match(/[^.!?]+[.!?]+(?:\s|$)/g) ?? [];
  let out = "";
  for (const s of sentences) {
    if (out.length + s.length > max) break;
    out += s;
  }
  out = out.trim();
  if (out) return out;
  // No sentence fits (e.g. scraped table/nav text): cut at last word boundary.
  const head = text.slice(0, max);
  const lastSpace = head.lastIndexOf(" ");
  return (lastSpace > 0 ? head.slice(0, lastSpace) : head).trimEnd();
}

async function tavilySearch(body: Record<string, unknown>): Promise<{
  results?: {
    title?: string;
    url?: string;
    content?: string;
    raw_content?: string | null;
    published_date?: string;
    score?: number;
  }[];
}> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY not set — blog dataSource cannot ground articles");
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: apiKey, ...body }),
        signal: AbortSignal.timeout(TAVILY_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`tavily ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return (await res.json()) as Awaited<ReturnType<typeof tavilySearch>>;
    } catch (err) {
      if (attempt >= 1) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/**
 * factSheet builder: every number the article uses must appear here verbatim
 * (§19.6), so facts carry their source URL and publication date inline.
 * statCapacity counts numeric tokens so quality.contract.minNamedStats clamps
 * honestly on thin-news days instead of failing gate 1.
 */
export const newsDataProvider: BlogDataProvider = {
  async getContext(entry, phase): Promise<BlogDataContext> {
    const data = await tavilySearch({
      query: `${entry.title} ${entry.keywords.slice(0, 3).join(" ")}`.trim(),
      topic: "news",
      days: phase === "generate" ? 7 : 30,
      max_results: 8,
      search_depth: "advanced",
      // Snippets alone scored dataCompleteness 2/5 on the canary run; full
      // page text (capped per source below) gives the writer real numbers.
      include_raw_content: true,
    });
    const results = (data.results ?? []).filter((r) => r.title && r.url && r.content);
    if (results.length === 0) {
      throw new Error(`no sources found for "${entry.title}" — skipping run (WARN)`);
    }

    const sections = results.map((r, i) => {
      const body =
        truncateAtSentence((r.raw_content ?? "").replace(/\s+\n/g, "\n").trim()) ||
        (r.content ?? "").trim();
      // Raw feed dates ("Thu, 18 Jun 2026 09:10:07 GMT") passed straight
      // through this builder and were PUBLISHED verbatim in article copy
      // (2026-07-14 process review, finding P3) — normalize here, and flag
      // year-old sources so the writer states their age (checklist item 6).
      const published = formatSourceDate(r.published_date);
      const ageDays = sourceAgeDays(r.published_date);
      const ageNote =
        ageDays !== null && ageDays > 365
          ? " (NOTE: more than a year old; the article must state its age)"
          : "";
      const outlet = outletFromUrl(r.url!);
      return [
        `## Source ${i + 1}: ${r.title}`,
        `Published: ${published ?? "date unknown; do not present as recent"}${ageNote}`,
        `Cite as: [${outlet}](${r.url}) — link this URL at the source's first mention`,
        ``,
        body,
      ].join("\n");
    });
    const factsMarkdown = [
      `# Fact sheet: ${entry.title}`,
      `Compiled ${new Date().toISOString()} from ${results.length} news sources via Tavily.`,
      `Every claim and number in the article must trace to a source section below.`,
      `Every cited source must be hyperlinked at first mention using its "Cite as" URL verbatim; never use any other external URL.`,
      ...sections,
    ].join("\n\n");

    // Independent numeric facts available to the writer (dollar amounts,
    // percentages, large counts).
    const statCapacity = Math.min(
      new Set(factsMarkdown.match(/(?:\$[\d,.]+[MBK]?|\d+(?:\.\d+)?%|\b\d{2,}(?:,\d{3})+\b)/g) ?? []).size,
      10,
    );

    return {
      factsMarkdown,
      statCapacity,
      autoLinkTerms: [],
    };
  },
};
