// Federal Reserve Large Commercial Banks release (LBR) lookup (§5.12).
// The quarterly release ranks every domestically chartered commercial bank by
// consolidated assets; the FFIEC offering uses it to pre-fill a bank's asset
// figure and derive the proportionality tier the drafting prompt calibrates
// to. Savings institutions and credit unions are NOT in the release, so every
// caller must treat "no match" as a normal outcome (the interview simply asks
// the user, per the owner's requirement).
//
// Cache discipline: data/lbr/ is written tmp+rename by TWO writers with
// idempotent content (the upstream file is the same bytes for a quarter):
// the daily refresh timer is the writer of record (refetch when older than
// LBR_REFRESH_DAYS), and the research script may bootstrap the cache when the
// file is absent or hopelessly stale. A rare concurrent write is harmless by
// construction; this is a deliberate, documented exception to the
// state.json-style single-writer rule.
//
// Parse discipline: linear passes only, no backtracking-prone regexes over
// the 1 MB body (the docx O(n^2) lesson).

import fs from "node:fs";
import path from "node:path";
import type { AssetTier } from "./types";
import { safeFetch } from "./research";

export const LBR_URL =
  "https://www.federalreserve.gov/releases/lbr/current/lrg_bnk_lst.txt";
export const LBR_DIR = path.join(process.cwd(), "data", "lbr");
export const LBR_FILE = path.join(LBR_DIR, "lrg_bnk_lst.txt");
export const LBR_META = path.join(LBR_DIR, "meta.json");
/** Writer-of-record refetch cadence (days); release itself is quarterly. */
export const LBR_REFRESH_DAYS = 7;
/** Readers accept a cached file up to this old (quarterly + margin). */
export const LBR_STALE_DAYS = 100;

export interface LbrBank {
  name: string; // full name incl. holding co, wrapped lines joined
  rank: number;
  rssdId: string;
  city: string;
  state: string;
  charter: string; // NAT | SMB | NMB | ILC | NMTC | SMTC | ...
  consolAssetsMil: number;
}

export interface LbrData {
  asOf: string; // ISO yyyy-mm-dd from the release header
  banks: LbrBank[];
}

export interface LbrMatch {
  bank: LbrBank;
  confidence: "high" | "low";
}

/* ------------------------------------------------------------------ *
 * Fetch + cache
 * ------------------------------------------------------------------ */

function writeCache(body: string, asOf: string): void {
  fs.mkdirSync(LBR_DIR, { recursive: true });
  const tmp = `${LBR_FILE}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o644 });
  fs.renameSync(tmp, LBR_FILE);
  const metaTmp = `${LBR_META}.tmp`;
  fs.writeFileSync(
    metaTmp,
    JSON.stringify({ fetchedAt: new Date().toISOString(), asOf }, null, 2),
    { mode: 0o644 }
  );
  fs.renameSync(metaTmp, LBR_META);
}

export function lbrCacheAgeDays(): number | null {
  try {
    const meta = JSON.parse(fs.readFileSync(LBR_META, "utf8")) as {
      fetchedAt?: string;
    };
    if (!meta.fetchedAt) return null;
    return (Date.now() - Date.parse(meta.fetchedAt)) / 86_400_000;
  } catch {
    return null;
  }
}

/** Fetch the release and refresh the cache. Returns parsed data or null;
 * never throws (LBR is always best-effort for callers). */
export async function refetchLbr(): Promise<LbrData | null> {
  const res = await safeFetch(LBR_URL, { maxBytes: 2_000_000, timeoutMs: 20_000 });
  if (!res || res.status !== 200 || res.body.length < 10_000) return null;
  const parsed = parseLbr(res.body);
  if (!parsed || parsed.banks.length < 100) return null;
  try {
    writeCache(res.body, parsed.asOf);
  } catch {
    // cache write failure never blocks the in-memory result
  }
  return parsed;
}

/**
 * Cached-first load for research runs: serve the on-disk file when present
 * and younger than LBR_STALE_DAYS; bootstrap-fetch when absent; one refetch
 * attempt when stale. Null = no usable data (research proceeds without it).
 */
export async function loadLbr(): Promise<LbrData | null> {
  const age = lbrCacheAgeDays();
  if (age !== null && age <= LBR_STALE_DAYS) {
    try {
      const parsed = parseLbr(fs.readFileSync(LBR_FILE, "utf8"));
      if (parsed && parsed.banks.length >= 100) return parsed;
    } catch {
      // fall through to refetch
    }
  }
  return refetchLbr();
}

/* ------------------------------------------------------------------ *
 * Parse (header-derived fixed-width columns, wrapped-name continuation)
 * ------------------------------------------------------------------ */

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05",
  june: "06", july: "07", august: "08", september: "09", october: "10",
  november: "11", december: "12",
};

/** "As of March 31, 2026" -> "2026-03-31"; "" when absent. */
function extractAsOf(header: string): string {
  const m = /As of ([A-Za-z]+) (\d{1,2}), (\d{4})/.exec(header);
  if (!m) return "";
  const month = MONTHS[m[1].toLowerCase()];
  if (!month) return "";
  return `${m[3]}-${month}-${m[2].padStart(2, "0")}`;
}

export function parseLbr(text: string): LbrData | null {
  const lines = text.split("\n");
  const asOf = extractAsOf(lines.slice(0, 8).join("\n"));
  // Locate the dashed column ruler under the header; its dash runs define
  // the fixed-width column extents for every record line.
  let rulerIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    if (/^-{5,} /.test(lines[i]) && lines[i].split(" ").length >= 8) {
      rulerIdx = i;
      break;
    }
  }
  if (rulerIdx === -1) return null;
  const ruler = lines[rulerIdx];
  // Column extents: [start, end) of each dash run.
  const cols: { start: number; end: number }[] = [];
  let start = -1;
  for (let i = 0; i <= ruler.length; i++) {
    const isDash = ruler[i] === "-";
    if (isDash && start === -1) start = i;
    if (!isDash && start !== -1) {
      cols.push({ start, end: i });
      start = -1;
    }
  }
  if (cols.length < 6) return null;
  const field = (line: string, c: { start: number; end: number }) =>
    line.slice(c.start, c.end).trim();

  const banks: LbrBank[] = [];
  let current: LbrBank | null = null;
  for (let i = rulerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (/^Summary:|^Note:/i.test(line)) break;
    const name = field(line, cols[0]);
    const rankStr = field(line, cols[1]);
    const rank = parseInt(rankStr, 10);
    if (name && Number.isFinite(rank) && /^\d+$/.test(rankStr)) {
      // New record. Location column holds "CITY, ST".
      const loc = field(line, cols[3]);
      const locMatch = /^(.*),\s*([A-Z]{2})$/.exec(loc);
      current = {
        name,
        rank,
        rssdId: field(line, cols[2]),
        city: locMatch ? locMatch[1].trim() : loc,
        state: locMatch ? locMatch[2] : "",
        charter: field(line, cols[4]),
        consolAssetsMil: parseInt(field(line, cols[5]).replace(/,/g, ""), 10) || 0,
      };
      banks.push(current);
    } else if (name && current) {
      // Continuation line: wrapped name (rank/id columns blank).
      current.name = `${current.name} ${name}`.trim();
    }
  }
  return { asOf, banks };
}

/* ------------------------------------------------------------------ *
 * Matching
 * ------------------------------------------------------------------ */

/** Fed name abbreviations expanded before token comparison. */
const ABBREV: Record<string, string> = {
  BK: "BANK", BKS: "BANKS", TC: "TRUST", "ST&TC": "TRUST", NA: "",
  BC: "", BSHRS: "", HC: "", CORP: "", CO: "", FSB: "SAVINGS",
  SVG: "SAVINGS", SVGS: "SAVINGS", CMRL: "COMMERCIAL", NAT: "NATIONAL",
  ST: "STATE", MRCH: "MERCHANTS", FNCL: "FINANCIAL",
};
/** Tokens too generic to identify a bank on their own. */
const STOPWORDS = new Set([
  "BANK", "BANKS", "TRUST", "COMPANY", "NATIONAL", "STATE", "SAVINGS",
  "COMMERCIAL", "FINANCIAL", "MERCHANTS", "THE", "OF", "AND", "FIRST",
  "", // empty after abbrev drop
]);

export function normalizeBankTokens(name: string): {
  all: Set<string>;
  distinctive: Set<string>;
} {
  const tokens = name
    .toUpperCase()
    .replace(/[^A-Z0-9& ]/g, " ")
    .split(/[\s/]+/)
    .map((t) => (t in ABBREV ? ABBREV[t] : t))
    .filter(Boolean);
  const all = new Set(tokens);
  const distinctive = new Set(tokens.filter((t) => !STOPWORDS.has(t)));
  return { all, distinctive };
}

/**
 * Conservative bank-name match. `high` confidence requires the distinctive
 * tokens to agree bidirectionally AND either a city/state corroboration or a
 * single unambiguous candidate; ties and partials stay null or `low`. A
 * wrong match would put another bank's asset figure into a Board document,
 * so misses are always preferred over guesses.
 */
export function matchBank(
  banks: LbrBank[],
  companyName: string,
  cityHint?: string,
  stateHint?: string
): LbrMatch | null {
  const q = normalizeBankTokens(companyName);
  if (q.distinctive.size === 0) return null;
  const candidates: LbrBank[] = [];
  for (const b of banks) {
    // LBR names carry "BANK / HOLDING CO"; match against the bank segment
    // first, whole string second.
    const segment = b.name.split("/")[0] ?? b.name;
    for (const target of [segment, b.name]) {
      const t = normalizeBankTokens(target);
      if (t.distinctive.size === 0) continue;
      const qInT = [...q.distinctive].every((tok) => t.all.has(tok));
      const tInQ = [...t.distinctive].every((tok) => q.all.has(tok));
      if (qInT && tInQ) {
        candidates.push(b);
        break;
      }
    }
  }
  if (candidates.length === 0) return null;
  const cityN = (cityHint ?? "").trim().toUpperCase();
  const stateN = (stateHint ?? "").trim().toUpperCase();
  const corroborated = candidates.filter(
    (b) =>
      (cityN && b.city.toUpperCase() === cityN) ||
      (stateN && b.state.toUpperCase() === stateN)
  );
  if (corroborated.length === 1) return { bank: corroborated[0], confidence: "high" };
  if (candidates.length === 1)
    return {
      bank: candidates[0],
      confidence: cityN || stateN ? "low" : "high",
    };
  return null; // ambiguous: never guess between same-name banks
}

/* ------------------------------------------------------------------ *
 * Tiering + display
 * ------------------------------------------------------------------ */

export function assetTier(consolAssetsMil: number): AssetTier {
  if (consolAssetsMil < 1_000) return "under-1b";
  if (consolAssetsMil < 10_000) return "1b-10b";
  if (consolAssetsMil < 30_000) return "10b-30b";
  return "over-30b";
}

export const TIER_LABELS: Record<AssetTier, string> = {
  "under-1b": "community bank under $1 billion",
  "1b-10b": "community bank, $1 billion to $10 billion",
  "10b-30b": "mid-size bank, $10 billion to $30 billion",
  "over-30b": "large bank, over $30 billion",
};

/** Hedged proportionality guidance for the drafting prompt. Depth and
 * structure scale with the tier; obligations never disappear at any size. */
export function tierGuidance(tier: AssetTier): string {
  switch (tier) {
    case "under-1b":
    case "1b-10b":
      return "Community-bank calibration: an existing risk or IT steering committee with an expanded charter is acceptable, outsourced or pooled model validation is acceptable, internal audit may be outsourced, and artifacts stay deliberately simple. Annual Board reporting is a reasonable baseline. Obligations never shrink with size; only the machinery does.";
    case "10b-30b":
      return "Mid-size calibration: name a second-line owner for AI risk, state a fair lending testing cadence explicitly (consumer-compliance supervision intensifies above $10 billion in assets), and document in-house effective challenge for material models with outsourcing as a supplement. Semiannual management reporting and annual Board reporting are a reasonable baseline.";
    case "over-30b":
      return "Large-bank calibration: supervisors apply their fullest model risk expectations at this scale, so draft for a standalone model risk function, independent validation, internal audit coverage of AI named in the audit plan, and quarterly Board risk committee reporting. Expectations rise further with size; the largest institutions face large financial institution standards and should treat these drafts as scaffolding for a dedicated program.";
  }
}

/** "$835 million" / "$1.2 billion" / "$4.0 trillion", for chips and lines. */
export function fmtAssetsMil(mil: number): string {
  if (mil >= 1_000_000)
    return `$${(Math.round((mil / 1_000_000) * 10) / 10).toFixed(1)} trillion`;
  if (mil >= 1_000) {
    const b = mil / 1_000;
    const rounded = b >= 100 ? Math.round(b) : Math.round(b * 10) / 10;
    return `$${rounded} billion`;
  }
  return `$${Math.round(mil)} million`;
}

/** "2026-03-31" -> "March 31, 2026" (falls back to the raw string). */
export function fmtAsOf(asOf: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(asOf);
  if (!m) return asOf;
  const names = Object.keys(MONTHS);
  const name = names.find((n) => MONTHS[n] === m[2]);
  if (!name) return asOf;
  return `${name[0].toUpperCase()}${name.slice(1)} ${parseInt(m[3], 10)}, ${m[1]}`;
}

/** Charter code -> plain description + primary federal regulator. Only the
 * three unambiguous commercial charters decode; everything else is unknown
 * (a wrong regulator in a Board document is the unrecoverable error). */
export function decodeCharter(
  charter: string
): { description: string; regulator: string } | null {
  switch (charter.toUpperCase()) {
    case "NAT":
      return { description: "national bank", regulator: "OCC" };
    case "SMB":
      return { description: "state member bank", regulator: "Federal Reserve" };
    case "NMB":
      return { description: "state nonmember bank", regulator: "FDIC" };
    default:
      return null;
  }
}
