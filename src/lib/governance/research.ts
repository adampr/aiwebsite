// Governance research plumbing (§5.12): the SSRF-hardened fetcher for the
// user-domain crawl, the Tavily helper, the prompt-injection screen, and
// research-brief shaping. Server-only (node imports) — used by the detached
// research script and the standards refresh script; never by client code.

import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import type {
  ApplicabilitySignal,
  ResearchAudit,
  ResearchBrief,
  TavilyResult,
} from "./types";
import { isGovernanceKind } from "./types";
import { CAPS } from "./config";
import { MAX_APPLICABILITY_SIGNALS, sanitizeSignalSource } from "./probes";

/* ------------------------------------------------------------------ *
 * SSRF-hardened fetch
 *
 * The crawl target is a USER-CONTROLLED domain and this code runs on the VM
 * next to loopback services (:3211 brain-api, :3213 skills-host, :5432
 * Postgres) and the Azure Instance Metadata Service (169.254.169.254). Every
 * connection therefore: http/https only, default ports only, and a custom
 * DNS lookup that rejects any private/loopback/link-local/CGNAT/multicast
 * address. Because the SAME lookup result is used for the actual connect,
 * DNS rebinding cannot swap the address between check and use. Redirects are
 * followed manually (max 3) and every hop re-runs the full validation.
 * ------------------------------------------------------------------ */

function ipv4ToInt(ip: string): number {
  const p = ip.split(".").map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

function inCidr4(ip: number, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ip & mask) === (ipv4ToInt(base) & mask);
}

const BLOCKED_V4: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local incl. Azure IMDS
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3], // multicast + reserved + broadcast
];

export function isBlockedAddress(addr: string): boolean {
  const family = isIP(addr);
  if (family === 4) {
    const ip = ipv4ToInt(addr);
    return BLOCKED_V4.some(([base, bits]) => inCidr4(ip, base, bits));
  }
  if (family === 6) {
    const a = addr.toLowerCase();
    // Reject everything except plain global unicast 2000::/3.
    if (a.startsWith("::ffff:")) return isBlockedAddress(a.slice(7));
    if (a === "::" || a === "::1") return true;
    const first = parseInt(a.split(":")[0] || "0", 16);
    return !(first >= 0x2000 && first <= 0x3fff);
  }
  return true; // not an IP at all
}

/**
 * dns.lookup wrapper that fails when ANY resolved address is blocked. The
 * validated resolution is what the socket actually connects to, so rebinding
 * cannot swap the address between check and use. Node 20+ Happy Eyeballs
 * (autoSelectFamily) calls lookup with `all: true` and expects an ARRAY
 * callback — honor both shapes.
 */
function safeLookup(
  hostname: string,
  options: unknown,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | { address: string; family: number }[],
    family?: number
  ) => void
): void {
  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err, "", 4);
    const bad = addresses.find((a) => isBlockedAddress(a.address));
    if (bad || addresses.length === 0) {
      const e: NodeJS.ErrnoException = new Error(
        `blocked address for ${hostname}`
      );
      e.code = "EBLOCKED";
      return callback(e, "", 4);
    }
    const wantAll =
      typeof options === "object" &&
      options !== null &&
      (options as { all?: boolean }).all === true;
    if (wantAll)
      return callback(
        null,
        addresses.map((a) => ({ address: a.address, family: a.family }))
      );
    const a = addresses[0];
    callback(null, a.address, a.family);
  });
}

export interface SafeFetchResult {
  status: number;
  finalUrl: string;
  body: string;
  contentType: string;
}

/**
 * Fetch a URL with the guards above. Text responses only, size-capped.
 * Returns null on any policy violation or network failure (callers treat a
 * page as simply unavailable).
 */
export async function safeFetch(
  url: string,
  opts: { maxBytes?: number; timeoutMs?: number; userAgent?: string } = {},
  redirectsLeft = 3
): Promise<SafeFetchResult | null> {
  const maxBytes = opts.maxBytes ?? 300_000;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.port && u.port !== "80" && u.port !== "443") return null;
  if (u.username || u.password) return null;
  // A literal IP in the URL never touches DNS — validate it directly.
  if (isIP(u.hostname.replace(/^\[|\]$/g, "")) && isBlockedAddress(u.hostname.replace(/^\[|\]$/g, "")))
    return null;

  return new Promise((resolve) => {
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      u,
      {
        method: "GET",
        lookup: safeLookup as never,
        headers: {
          "user-agent":
            opts.userAgent ??
            "Mozilla/5.0 (compatible; TronNetterGovernanceBot/1.0; +https://ai.xl.net/governance)",
          accept: "text/html,application/xhtml+xml,text/plain,*/*;q=0.5",
        },
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const loc = res.headers.location;
        if (status >= 300 && status < 400 && loc) {
          res.resume();
          if (redirectsLeft <= 0) return resolve(null);
          let next: string;
          try {
            next = new URL(loc, u).toString();
          } catch {
            return resolve(null);
          }
          return resolve(safeFetch(next, opts, redirectsLeft - 1));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve({
            status,
            finalUrl: u.toString(),
            body: Buffer.concat(chunks).toString("utf8"),
            contentType: String(res.headers["content-type"] || ""),
          });
        };
        res.on("data", (c: Buffer) => {
          size += c.length;
          chunks.push(c);
          if (size > maxBytes) {
            // Oversized page: keep the truncated body (the homepage is often
            // the most important page) and stop reading.
            finish();
            req.destroy();
          }
        });
        res.on("end", finish);
        res.on("error", () => {
          if (!settled) resolve(null);
        });
      }
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    req.end();
  });
}

/** HTML → readable text (same discipline as the knowledge crawler). */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(nav|header|footer|form)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#\d+;|&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ *
 * Tavily (api key in body — the fetch-ai-news.mjs pattern)
 * ------------------------------------------------------------------ */

export async function tavilySearch(body: {
  query: string;
  max_results?: number;
  search_depth?: "basic" | "advanced";
  topic?: string;
  days?: number;
  // Domain-restricted searches (§5.12 FFIEC): Tavily serves indexed content
  // for hosts that hard-block direct fetches (ithandbook.ffiec.gov CAPTCHAs
  // every crawler we have), so a restricted search is the only working
  // change-detection leg for those sources.
  include_domains?: string[];
}): Promise<TavilyResult[]> {
  const key = process.env.TAVILY_API_KEY || "";
  if (!key) throw new Error("TAVILY_API_KEY not set");
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: key, ...body }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok)
        throw new Error(`tavily ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = (await res.json()) as { results?: unknown[] };
      return (data.results || []).flatMap((r) => {
        const o = r as Record<string, unknown>;
        if (typeof o.title !== "string" || typeof o.url !== "string") return [];
        return [
          {
            title: o.title,
            url: o.url,
            content: typeof o.content === "string" ? o.content : "",
            score: typeof o.score === "number" ? o.score : null,
          },
        ];
      });
    } catch (err) {
      if (attempt >= 1) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/* ------------------------------------------------------------------ *
 * Prompt-injection screen — applied to stored research briefs, applied doc
 * sections, and authored standards docs. Matching lines are dropped and the
 * artifact is flagged (WARN line in the next report email; content itself is
 * never emailed or logged).
 * ------------------------------------------------------------------ */

const INJECTION_PATTERNS: RegExp[] = [
  /ignore (all|any|previous|prior|the above)/i,
  /disregard (all|any|previous|prior)/i,
  /system prompt/i,
  /you are now/i,
  /new instructions?:/i,
  /<\s*untrusted/i,
  /do_not_store|store_persistent|memoryMode/i,
  /\bBEGIN (SYSTEM|INSTRUCTIONS)\b/i,
  /reveal (your|the) (prompt|instructions)/i,
];

export function screenInjection(text: string): {
  clean: string;
  hits: string[];
} {
  const hits: string[] = [];
  const kept = text.split("\n").filter((line) => {
    const hit = INJECTION_PATTERNS.find((p) => p.test(line));
    if (hit) {
      hits.push(hit.source.slice(0, 40));
      return false;
    }
    return true;
  });
  return { clean: kept.join("\n"), hits };
}

/**
 * Screen a model-emitted suspicion note for storage. Unlike screenInjection
 * (which drops matching lines), a note that matches gets a redaction stub:
 * notes routinely QUOTE the injection they are reporting, and deleting them
 * would destroy exactly the evidence the audit exists to keep.
 */
export function screenSuspicionNote(note: string): string {
  const { clean, hits } = screenInjection(note);
  if (!hits.length) return clean.trim();
  return `[redacted: matched ${hits.join(", ")}]`;
}

/* ------------------------------------------------------------------ *
 * Pure text/URL helpers (unit-tested in scripts/governance-tests.ts)
 * ------------------------------------------------------------------ */

/**
 * Truncate at a word boundary: never longer than max, and when a cut is
 * needed it backtracks to the last whitespace past max/2 (degenerate
 * whitespace-free strings keep the hard cut). Replaces mid-word .slice()
 * chops that shipped fragments like "month-t" into prompts.
 */
export function cutAtWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const hard = s.slice(0, max);
  const at = hard.search(/\s\S*$/);
  return (at > max / 2 ? hard.slice(0, at) : hard).trimEnd();
}

/**
 * Content-identity key for crawl dedupe: https-forced, lowercased host with
 * one leading "www." stripped, query/hash dropped, trailing slash stripped.
 * Applied to both the pre-redirect URL (skip before spending a fetch) and
 * the post-redirect finalUrl (a www.->apex redirect must never let the same
 * canonical page consume a second slot of the 12-page budget).
 */
export function crawlDedupeKey(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    return `https://${host}${u.pathname.replace(/\/$/, "")}`;
  } catch {
    return url;
  }
}

/**
 * Company-name fallback from a homepage <title>. Splits only on |, the
 * middot, or a SPACED hyphen/en dash (a bare hyphen inside "Blue-Sky" never
 * splits), then prefers the segment containing the domain's first label as a
 * word (label >= 3 chars, word-bounded: "art.com" must not match "Smart").
 * No segment-length guessing: taglines like "Managed IT Services Chicago |
 * XL.net" beat any heuristic only via the domain match; when nothing
 * matches, returns "" and the caller falls back to the bare domain label
 * with domain-scoped queries (a weak anchor is recoverable; a wrong one
 * poisons the whole mentions pool).
 */
export function companyNameFromTitle(title: string, domain: string): string {
  const segments = title
    .split(/\s*[|·]\s*|\s+[-–—]\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!segments.length) return "";
  if (segments.length === 1) return segments[0].slice(0, 80);
  const label = domain.split(".")[0].toLowerCase();
  if (label.length >= 3) {
    const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?:^|[^a-z0-9])${esc}(?:[^a-z0-9]|$)`, "i");
    const hit = segments.find((seg) => re.test(seg));
    if (hit) return hit.slice(0, 80);
  }
  return "";
}

/** Enforce the audit ceiling: per-field caps, then shed trailing facts. */
export function truncateAudit(a: ResearchAudit): ResearchAudit {
  const b: ResearchAudit = {
    ...a,
    facts: a.facts.slice(0, 60).map((f) => ({
      fact: cutAtWord(f.fact, 300),
      source: f.source.slice(0, 200),
    })),
    suspicious: a.suspicious.slice(0, 20).map((s) => ({
      phase: s.phase,
      note: cutAtWord(s.note, 200),
    })),
    screenHits: a.screenHits.slice(0, 20).map((h) => h.slice(0, 60)),
  };
  while (
    JSON.stringify(b).length > CAPS.researchAuditMaxChars &&
    b.facts.length > 0
  ) {
    b.facts = b.facts.slice(0, -1);
  }
  return b;
}

/* ------------------------------------------------------------------ *
 * Brief shaping
 * ------------------------------------------------------------------ */

export function emptyBrief(gaps: string[]): ResearchBrief {
  return {
    companyProfile: "",
    companyName: "",
    sizeAndFootprint: "",
    industryContext: "",
    aiUseSignals: [],
    regulatoryExposure: [],
    applicabilitySignals: [],
    probedKind: null,
    dataSensitivity: "",
    openQuestions: [],
    topSources: [],
    gaps,
    confidenceNotes:
      "Research was limited; treat every statement as unconfirmed and rely on the user's answers.",
    distilledAt: new Date().toISOString(),
  };
}

/**
 * Shape an arbitrary stored value into a valid ResearchBrief, or null.
 * Briefs written before the applicability-probes change lack the new fields;
 * this defaulting layer is what keeps existing projects and 30-day brief
 * reuse working across the upgrade (and across a rollback: old code simply
 * ignores the extra JSON fields).
 */
export function normalizeBrief(v: unknown): ResearchBrief | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.distilledAt !== "string" || !o.distilledAt) return null;
  const str = (x: unknown) => (typeof x === "string" ? x : "");
  const arr = (x: unknown) =>
    Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : [];
  const signals: ApplicabilitySignal[] = Array.isArray(o.applicabilitySignals)
    ? o.applicabilitySignals.flatMap((s) => {
        const g = s as Record<string, unknown>;
        if (typeof g?.probeId !== "string" || typeof g?.finding !== "string")
          return [];
        return [
          {
            probeId: g.probeId,
            trigger: str(g.trigger),
            finding: g.finding,
            source: sanitizeSignalSource(str(g.source)),
            confidence: g.confidence === "likely" ? ("likely" as const) : ("unclear" as const),
          },
        ];
      })
    : [];
  return {
    companyProfile: str(o.companyProfile),
    companyName: str(o.companyName),
    sizeAndFootprint: str(o.sizeAndFootprint),
    industryContext: str(o.industryContext),
    aiUseSignals: arr(o.aiUseSignals),
    regulatoryExposure: arr(o.regulatoryExposure),
    applicabilitySignals: signals,
    probedKind: isGovernanceKind(o.probedKind) ? o.probedKind : null,
    dataSensitivity: str(o.dataSensitivity),
    openQuestions: arr(o.openQuestions),
    topSources: arr(o.topSources),
    gaps: arr(o.gaps),
    confidenceNotes: str(o.confidenceNotes),
    distilledAt: o.distilledAt,
  };
}

/** Enforce the brief ceiling array-wise, cutting prose at word boundaries
 * (URLs and ids keep hard slices — a word-cut URL is a broken URL). */
export function truncateBrief(brief: ResearchBrief): ResearchBrief {
  const b: ResearchBrief = {
    ...brief,
    companyProfile: cutAtWord(brief.companyProfile, 1200),
    companyName: (brief.companyName ?? "").slice(0, 80),
    sizeAndFootprint: cutAtWord(brief.sizeAndFootprint, 600),
    industryContext: cutAtWord(brief.industryContext, 1200),
    dataSensitivity: cutAtWord(brief.dataSensitivity, 600),
    confidenceNotes: cutAtWord(brief.confidenceNotes, 600),
    aiUseSignals: brief.aiUseSignals.slice(0, 10).map((s) => cutAtWord(s, 200)),
    regulatoryExposure: brief.regulatoryExposure
      .slice(0, 10)
      .map((s) => cutAtWord(s, 200)),
    applicabilitySignals: (brief.applicabilitySignals ?? [])
      .slice(0, MAX_APPLICABILITY_SIGNALS)
      .map((s) => ({
        probeId: s.probeId.slice(0, 40),
        trigger: s.trigger.slice(0, 80),
        finding: cutAtWord(s.finding, 200),
        source: sanitizeSignalSource(s.source),
        confidence: s.confidence === "likely" ? ("likely" as const) : ("unclear" as const),
      })),
    probedKind: brief.probedKind ?? null,
    openQuestions: brief.openQuestions.slice(0, 8).map((s) => cutAtWord(s, 200)),
    topSources: brief.topSources.slice(0, 10).map((s) => s.slice(0, 160)),
    gaps: brief.gaps.slice(0, 8).map((s) => cutAtWord(s, 120)),
  };
  const drop: (keyof Pick<
    ResearchBrief,
    "aiUseSignals" | "regulatoryExposure" | "openQuestions" | "topSources"
  >)[] = ["topSources", "aiUseSignals", "regulatoryExposure", "openQuestions"];
  let i = 0;
  while (JSON.stringify(b).length > CAPS.researchBriefMaxChars && i < 40) {
    const key = drop[i % drop.length];
    if (b[key].length > 2) b[key] = b[key].slice(0, b[key].length - 1);
    i++;
  }
  // Applicability signals shed LAST: only when the generic arrays are already
  // at their floors and the brief still exceeds the ceiling.
  while (
    JSON.stringify(b).length > CAPS.researchBriefMaxChars &&
    b.applicabilitySignals.length > 0
  ) {
    b.applicabilitySignals = b.applicabilitySignals.slice(0, -1);
  }
  return b;
}

export function briefToPromptBlock(brief: ResearchBrief): string {
  const lines = [
    `Company profile: ${brief.companyProfile || "(unknown)"}`,
    `Size and footprint: ${brief.sizeAndFootprint || "(unknown)"}`,
    `Industry context: ${brief.industryContext || "(unknown)"}`,
    `AI use signals: ${brief.aiUseSignals.join("; ") || "(none found)"}`,
    `Regulatory exposure: ${brief.regulatoryExposure.join("; ") || "(none found)"}`,
    `Standard applicability signals (public-source observations to confirm with the user, not determinations): ${
      (brief.applicabilitySignals ?? []).length
        ? brief.applicabilitySignals
            .map(
              (s) =>
                `${s.trigger}: ${s.finding}${s.source ? ` [${s.source}]` : ""} (confidence: ${s.confidence})`
            )
            .join("; ")
        : "(none)"
    }`,
    `Data sensitivity: ${brief.dataSensitivity || "(unknown)"}`,
    `Open questions worth asking the user: ${brief.openQuestions.join(" | ") || "(none)"}`,
    `Research gaps: ${brief.gaps.join(", ") || "none"}`,
    `Confidence notes: ${brief.confidenceNotes}`,
  ];
  return lines.join("\n");
}
