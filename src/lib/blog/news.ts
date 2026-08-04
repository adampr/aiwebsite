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

/**
 * Rankability framing (owner directive 2026-07-25), appended to EVERY
 * calendar entry description ahead of any peg-less framing. The entry title
 * above the brief is the source outlet's own headline; a zero-authority
 * subdomain cannot outrank the outlet for its own headline (the 07-24 post
 * mirrored VentureBeat's and was absent from that SERP), so the writer must
 * compose a differentiated title and framing. Same haystack caveat as
 * REPORT_OF_RECORD_BRIEF above: this text flows into checkTopic's
 * offLimits/protectedKeywords scan — keep the wording neutral (pinned by
 * scripts/peg-score-tests.mjs).
 */
// 2026-07-27 reword (fact-check WARN "Moonshot Changes SMB Costs"): the
// unconditional "changes, costs, or requires" triad pushed the writer to
// invent an SMB-effect claim on a sheet with no SMB-effect facts, which the
// fact-check gate then failed — the brief now points the same direction as
// the gate. The casing sentence closes the primary-keyword leak (the 07-27
// meta description shipped lowercase "chinese" copied verbatim from
// primary_keyword "panic around chinese").
const RANKABILITY_BRIEF =
  " ANGLE (rankability): the working title of this entry is the source " +
  "outlet's own search headline. It is a retrieval key, never the article " +
  "title. Major outlets already own that headline in search; do not compete " +
  "for it or echo its wording. Compose the title and framing for the " +
  "follow-up question a small or mid-sized business owner or IT " +
  "decision-maker would search after seeing this news: what it changes, " +
  "costs, or requires for a business like theirs when the sources establish " +
  "that; when they do not, the stake is what they do establish, such as " +
  "attention, availability, or debate, and the title claims no effect the " +
  "sources do not state. The assigned primary keyword and its sibling " +
  "keyword phrases are lowercase search strings, never copy: wherever " +
  "their words appear in the article, its title, or its description, they " +
  "take normal prose capitalization (proper nouns and nationalities " +
  "capitalized). The article is still a " +
  "dated news report with inline attribution; the SMB stake belongs in the " +
  "title and the closing take, not as opinion in the body.";

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
        news.top.description +
        RANKABILITY_BRIEF +
        (news.top.peg?.pegless ? REPORT_OF_RECORD_BRIEF : ""),
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

/**
 * Public editorial names for the outlets this pipeline actually surfaces.
 * 2026-07-25: the fact sheet's "Cite as:" line used the bare hostname and
 * the published article copied it ("foxbusiness.com reported"); the writer
 * imitates the sheet, so the display name must live in the sheet itself
 * (checklist item 3 keys off it, and the fact-check gate verifies named
 * facts against the sheet, so the name has to appear there verbatim).
 */
const OUTLET_NAMES: Record<string, string> = {
  "foxbusiness.com": "Fox Business",
  "bbc.com": "BBC",
  "bbc.co.uk": "BBC",
  "abcnews.go.com": "ABC News",
  "cbsnews.com": "CBS News",
  "aljazeera.com": "Al Jazeera",
  "cnbc.com": "CNBC",
  "reuters.com": "Reuters",
  "techcrunch.com": "TechCrunch",
  "theverge.com": "The Verge",
  "arstechnica.com": "Ars Technica",
  "csoonline.com": "CSO",
  "wsj.com": "The Wall Street Journal",
  "nytimes.com": "The New York Times",
  "ft.com": "Financial Times",
  "bloomberg.com": "Bloomberg",
  "wired.com": "Wired",
  "zdnet.com": "ZDNET",
  "venturebeat.com": "VentureBeat",
  "axios.com": "Axios",
  "theguardian.com": "The Guardian",
  // 2026-07-26: the 07-26 article shipped "Securityweek" — the title-case
  // fallback's output for an unmapped host, a soft recurrence of the 07-25
  // bare-domain outlet defect. CamelCase names need explicit entries.
  "securityweek.com": "SecurityWeek",
  // 2026-07-27: the 07-27 article shipped "Pbs", "Latimes", and
  // "Greenwichtime" (3rd recurrence of the fallback-name defect class).
  // The layered fallback in outletFromUrl now derives most long-tail names;
  // entries here stay the certainty layer for hosts already seen plus the
  // national outlets topic:"news" plausibly surfaces.
  "pbs.org": "PBS",
  "latimes.com": "Los Angeles Times",
  "greenwichtime.com": "Greenwich Time",
  "npr.org": "NPR",
  "apnews.com": "The Associated Press",
  "washingtonpost.com": "The Washington Post",
  "politico.com": "Politico",
  "cnn.com": "CNN",
  "nbcnews.com": "NBC News",
  "foxnews.com": "Fox News",
  "usatoday.com": "USA Today",
  "businessinsider.com": "Business Insider",
  "fortune.com": "Fortune",
  "forbes.com": "Forbes",
  "theinformation.com": "The Information",
  "semafor.com": "Semafor",
  "thehill.com": "The Hill",
  "technologyreview.com": "MIT Technology Review",
  "theatlantic.com": "The Atlantic",
  "news.sky.com": "Sky News",
  "nypost.com": "New York Post",
  "sfchronicle.com": "San Francisco Chronicle",
  // 2026-07-30: the 07-30 article shipped "Prnewswire" and "Finance Yahoo"
  // (4th recurrence of the fallback-name class). Press-release wires get the
  // certainty layer too: peg-score now demotes them (-wire), but demote is
  // never exclude, so on a thin news day a wire release can still lead and
  // its outlet name must render correctly in the "Cite as:" line.
  "prnewswire.com": "PR Newswire",
  "businesswire.com": "Business Wire",
  "globenewswire.com": "GlobeNewswire",
  "accesswire.com": "ACCESS Newswire",
  "prweb.com": "PRWeb",
  "einpresswire.com": "EIN Presswire",
  "newsfilecorp.com": "Newsfile",
  "openpr.com": "openPR",
  // Yahoo properties resolve by FULL host: outletFromUrl looks up the exact
  // hostname after stripping only "www.", so finance.yahoo.com never falls
  // through to a yahoo.com entry. Each subdomain needs its own row.
  "finance.yahoo.com": "Yahoo Finance",
  "news.yahoo.com": "Yahoo News",
  "yahoo.com": "Yahoo",
  // 2026-07-30 (5th fallback recurrence, seen in the Alloyed regenerate):
  // "News Ycombinator" shipped in live copy. aws.org is the American Welding
  // Society (exact-host match; Amazon is aws.amazon.com, a different host).
  "news.ycombinator.com": "Hacker News",
  "aws.org": "American Welding Society",
  // 2026-08-04 (6th fallback-name recurrence, Qwen3.8-Max article): five
  // wrong names in live copy, spanning three fallback layers. "Technode"
  // and "Aibusiness" were title-case last resorts (CamelCase / two-word
  // brands the fallback cannot derive); "QZ" came from the no-vowel
  // initialism branch (the brand is Quartz — a domain whose letters are NOT
  // the brand still needs a row); "News Cgtn" is the Yahoo-class subdomain
  // miss (bare cgtn.com would initialism-derive CGTN correctly;
  // news.cgtn.com cannot, so both hosts get rows); "Technology Org" is the
  // first wrong SUFFIX-layer name: the outlet's own feed suffix drops the
  // brand's dot and suffixNamesHost rightly tied it to the host. All five
  // are map gaps per the outletFromUrl doc rule; the fallback heuristics
  // are deliberately unchanged (cleverness cap: suffixNamesHost squash>=4).
  // The last-resort layers now WARN to stderr (see outletFromUrl) so the
  // 7th recurrence is caught in the nightly log BEFORE it ships in copy.
  "technode.global": "TechNode",
  "technode.com": "TechNode",
  "qz.com": "Quartz",
  "aibusiness.com": "AI Business",
  "news.cgtn.com": "CGTN",
  "cgtn.com": "CGTN",
  "technology.org": "Technology.org",
};

/** True when a "Headline - Publisher" title suffix plausibly names the
 *  source's host: its squashed letters (minus a leading "The") or its
 *  word-initials match the base domain. Keeps a coincidental subtitle
 *  suffix out of the gate-verified "Cite as:" line. The squash-prefix
 *  branch requires 4+ chars: at 3, generic suffixes like "- New" matched
 *  newsweek.com and "- News" matched any news*-prefixed host. */
function suffixNamesHost(candidate: string, base: string): boolean {
  const words = candidate.replace(/^The\s+/i, "").split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  const squash = words.join("").toLowerCase().replace(/[^a-z0-9]/g, "");
  const initials = words.map((w) => w[0]!.toLowerCase()).join("");
  const flat = base.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    (flat.length >= 3 && squash.startsWith(flat)) ||
    (squash.length >= 4 && flat.startsWith(squash)) ||
    (initials.length >= 3 && flat.startsWith(initials))
  );
}

/**
 * Citable outlet label for a source: the mapped display name; else the
 * "Headline - Publisher" suffix news feeds append to titles, accepted only
 * when it is 1-5 Capitalized words AND suffixNamesHost ties it to the
 * source's domain (Tavily titles carry the real editorial name for exactly
 * the long-tail outlets the map misses: "... - Greenwich Time"); else an
 * all-caps initialism when the base domain has no vowels (pbs -> PBS,
 * npr -> NPR); last resort, the title-cased base domain so the writer
 * never sees a raw hostname presented as an outlet name. A last-resort
 * name showing up in a run report is a map gap: add an OUTLET_NAMES entry.
 */
function outletFromUrl(url: string, sourceTitle?: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const mapped = OUTLET_NAMES[host];
    if (mapped) return mapped;
    const base = host.split(".").slice(0, -1).join(".") || host;
    const suffix = sourceTitle?.match(
      /\s[-–—|]\s((?:The\s+)?[A-Z][\w.&'’]*(?:\s+[A-Z&][\w.&'’]*){0,4})\s*$/,
    );
    if (suffix && suffixNamesHost(suffix[1]!, base)) return suffix[1]!;
    // Last-resort layers below are HEURISTIC GUESSES, not brand facts —
    // every wrong live-copy outlet name to date (6 recurrences) came from
    // them, and every one was caught by a human reading the published
    // article. The warn line puts the map gap in the nightly log (the
    // fetch script and blog run both write there) so it is patched BEFORE
    // the next article instead of after.
    if (/^[bcdfghjklmnpqrstvwxz]{2,6}$/.test(base)) {
      console.warn(`outlet-name fallback (map gap): ${host} -> "${base.toUpperCase()}" — add an OUTLET_NAMES entry`);
      return base.toUpperCase();
    }
    const guessed = base
      .split(/[-.]/)
      .map((p) => (p ? p[0]!.toUpperCase() + p.slice(1) : p))
      .join(" ");
    console.warn(`outlet-name fallback (map gap): ${host} -> "${guessed}" — add an OUTLET_NAMES entry`);
    return guessed;
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
      const outlet = outletFromUrl(r.url!, r.title);
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
