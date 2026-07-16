// Governance research plumbing (§5.12): the SSRF-hardened fetcher for the
// user-domain crawl, the Tavily helper, the prompt-injection screen, and
// research-brief shaping. Server-only (node imports) — used by the detached
// research script and the standards refresh script; never by client code.

import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import type { ResearchBrief, TavilyResult } from "./types";
import { CAPS } from "./config";

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

/* ------------------------------------------------------------------ *
 * Brief shaping
 * ------------------------------------------------------------------ */

export function emptyBrief(gaps: string[]): ResearchBrief {
  return {
    companyProfile: "",
    sizeAndFootprint: "",
    industryContext: "",
    aiUseSignals: [],
    regulatoryExposure: [],
    dataSensitivity: "",
    openQuestions: [],
    topSources: [],
    gaps,
    confidenceNotes:
      "Research was limited; treat every statement as unconfirmed and rely on the user's answers.",
    distilledAt: new Date().toISOString(),
  };
}

/** Enforce the brief ceiling array-wise (never mid-field). */
export function truncateBrief(brief: ResearchBrief): ResearchBrief {
  const b: ResearchBrief = {
    ...brief,
    companyProfile: brief.companyProfile.slice(0, 1200),
    sizeAndFootprint: brief.sizeAndFootprint.slice(0, 600),
    industryContext: brief.industryContext.slice(0, 1200),
    dataSensitivity: brief.dataSensitivity.slice(0, 600),
    confidenceNotes: brief.confidenceNotes.slice(0, 600),
    aiUseSignals: brief.aiUseSignals.slice(0, 10).map((s) => s.slice(0, 200)),
    regulatoryExposure: brief.regulatoryExposure
      .slice(0, 10)
      .map((s) => s.slice(0, 200)),
    openQuestions: brief.openQuestions.slice(0, 8).map((s) => s.slice(0, 200)),
    topSources: brief.topSources.slice(0, 10).map((s) => s.slice(0, 160)),
    gaps: brief.gaps.slice(0, 8).map((s) => s.slice(0, 80)),
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
  return b;
}

export function briefToPromptBlock(brief: ResearchBrief): string {
  const lines = [
    `Company profile: ${brief.companyProfile || "(unknown)"}`,
    `Size and footprint: ${brief.sizeAndFootprint || "(unknown)"}`,
    `Industry context: ${brief.industryContext || "(unknown)"}`,
    `AI use signals: ${brief.aiUseSignals.join("; ") || "(none found)"}`,
    `Regulatory exposure: ${brief.regulatoryExposure.join("; ") || "(none found)"}`,
    `Data sensitivity: ${brief.dataSensitivity || "(unknown)"}`,
    `Open questions worth asking the user: ${brief.openQuestions.join(" | ") || "(none)"}`,
    `Research gaps: ${brief.gaps.join(", ") || "none"}`,
    `Confidence notes: ${brief.confidenceNotes}`,
  ];
  return lines.join("\n");
}
