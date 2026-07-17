// Resolved-marker reveal data (§5.12). When a turn lands, the flight-owning
// tab diffs the pre-turn and post-turn documents to find [TO CONFIRM]
// markers that are genuinely GONE, and anchors the text that now stands in
// each one's place so the doc pane can play the owner's resolution reveal
// (highlight the old marker, type the replacement, pause, next).
//
// Honesty rules, non-negotiable:
// - A marker counts as resolved ONLY when its excerpt count dropped in the
//   committed after-text. A reworded marker is a NEW open item, never a
//   resolution (matching the workspace's count-delta receipts).
// - The replacement is ALWAYS a verbatim slice of the committed markdown,
//   located between the marker's own same-line context anchors. Ambiguous or
//   missing anchors, cross-line spans, over-long slices, and slices that
//   still contain a marker all yield NO reveal for that item; the section
//   keeps the ordinary Updated treatment instead. No fake success.
//
// Client-safe: imports markdown.ts + types only.

import {
  countConfirmMarkers,
  scanConfirmMarkers,
  scanConfirmMarkersWithPos,
} from "./markdown";
import type { GovernanceDoc } from "./types";

export interface ResolvedMarkerReveal {
  doc: string;
  section: string;
  excerpt: string;
  /** The literal old marker text, for the strike-out beat. */
  oldMarkerText: string;
  /** Span of the replacement in the section's COMMITTED post-turn markdown.
   *  An empty span (start === end) means the marker was simply deleted. */
  nextStart: number;
  nextEnd: number;
}

export const MAX_REVEALS = 20;
const ANCHOR_MAX = 40;
const SLICE_MAX = 300;

/** Transport guard for cross-tab reveal broadcasts (workspace.tsx): true
 *  only for a plausible ResolvedMarkerReveal. Span sanity against the
 *  receiving tab's actual markdown stays at render time (decorateMarkdown
 *  drops out-of-range offsets); this only rejects junk shapes. */
export function isRevealShape(v: unknown): v is ResolvedMarkerReveal {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.doc === "string" &&
    typeof r.section === "string" &&
    typeof r.excerpt === "string" &&
    typeof r.oldMarkerText === "string" &&
    Number.isInteger(r.nextStart) &&
    Number.isInteger(r.nextEnd) &&
    (r.nextStart as number) >= 0 &&
    (r.nextEnd as number) >= (r.nextStart as number)
  );
}

/* ------------------------------------------------------------------ *
 * Show planning (§5.12): pure so governance-tests can pin the budget
 * math. The runner in workspace.tsx plays exactly these beats; the
 * estimate MUST mirror them (the trim's honesty depends on it).
 * ------------------------------------------------------------------ */

export const MAX_SHOW_ITEMS = 5;
export const SHOW_BUDGET_MS = 15_000;
export const SHOW_TICK_MS = 60;

export function typingTicks(len: number): number {
  return Math.min(60, Math.max(20, Math.ceil(len / 2)));
}

/** Reduced-motion rest after the instant swap: length-scaled so a long
 *  insert the user never watched type still gets orientation time. */
export function reducedRestMs(len: number): number {
  return Math.min(3200, Math.max(1600, len * 12));
}

/** Honest per-item time estimate with the REAL beats that will play
 *  (same-section items skip the jump; deletion items skip typing). */
export function estimateItemMs(
  item: ResolvedMarkerReveal,
  prev: ResolvedMarkerReveal | null,
  reduce: boolean
): number {
  const sameSection =
    !!prev && prev.doc === item.doc && prev.section === item.section;
  const len = item.nextEnd - item.nextStart;
  if (reduce) {
    // One centered auto scroll inside the 1100ms strike beat; instant
    // swap; length-scaled rest. Deletions rest 1000ms (the strike showed
    // the removal).
    return 1100 + (len === 0 ? 1000 : reducedRestMs(len));
  }
  return (
    (sameSection ? 60 : 420) +
    900 +
    (len === 0 ? 0 : typingTicks(len) * SHOW_TICK_MS) +
    1000
  );
}

/** Trim the diffed items to the time budget and item cap, always playing
 *  at least one. Semantics pinned by tests: the cap check runs BEFORE the
 *  budget check, and the first item is budget-exempt. */
export function planShow(
  items: ResolvedMarkerReveal[],
  reduce: boolean
): ResolvedMarkerReveal[] {
  const played: ResolvedMarkerReveal[] = [];
  let est = 0;
  for (const it of items) {
    const cost = estimateItemMs(it, played[played.length - 1] ?? null, reduce);
    if (played.length >= MAX_SHOW_ITEMS) break;
    if (played.length > 0 && est + cost > SHOW_BUDGET_MS) break;
    played.push(it);
    est += cost;
  }
  return played;
}

function lineBounds(md: string, start: number, end: number) {
  const ls = md.lastIndexOf("\n", start - 1) + 1;
  const leRaw = md.indexOf("\n", end);
  return { ls, le: leRaw === -1 ? md.length : leRaw };
}

/** Word-trimmed tail anchor: the last chars of the pre-marker line text. */
function tailAnchor(s: string): string {
  if (s.length <= ANCHOR_MAX) return s;
  const cut = s.slice(s.length - ANCHOR_MAX);
  const sp = cut.indexOf(" ");
  return sp > 0 && sp < ANCHOR_MAX / 2 ? cut.slice(sp + 1) : cut;
}

/** Word-trimmed head anchor: the first chars of the post-marker line text. */
function headAnchor(s: string): string {
  if (s.length <= ANCHOR_MAX) return s;
  const cut = s.slice(0, ANCHOR_MAX);
  const sp = cut.lastIndexOf(" ");
  return sp > ANCHOR_MAX / 2 ? cut.slice(0, sp) : cut;
}

export function diffResolvedMarkers(
  prevDocs: GovernanceDoc[],
  nextDocs: GovernanceDoc[],
  changedSections: Record<string, string[]>
): ResolvedMarkerReveal[] {
  const out: ResolvedMarkerReveal[] = [];
  for (const [slug, secs] of Object.entries(changedSections)) {
    const pd = prevDocs.find((d) => d.slug === slug);
    const nd = nextDocs.find((d) => d.slug === slug);
    if (!pd || !nd) continue;
    for (const sid of secs) {
      if (out.length >= MAX_REVEALS) return out;
      const prevMd = pd.sections.find((s) => s.id === sid)?.markdown;
      const nextMd = nd.sections.find((s) => s.id === sid)?.markdown;
      if (prevMd === undefined || nextMd === undefined) continue;
      const before = scanConfirmMarkersWithPos(prevMd);
      if (!before.length) continue;
      const afterCounts = new Map<string, number>();
      for (const m of scanConfirmMarkers(nextMd))
        afterCounts.set(m.excerpt, (afterCounts.get(m.excerpt) ?? 0) + 1);
      for (const m of before) {
        if (out.length >= MAX_REVEALS) break;
        const remaining = afterCounts.get(m.excerpt) ?? 0;
        // The last (b - a) occurrences of this excerpt are the resolved ones.
        if (m.occurrence < remaining) continue;
        const { ls, le } = lineBounds(prevMd, m.start, m.end);
        const tail = tailAnchor(prevMd.slice(ls, m.start));
        const head = headAnchor(prevMd.slice(m.end, le));
        // Tier 1: exact context anchors (the fact was folded in place).
        // Tier 2: the model REWROTE the sentence while folding the fact in
        // (the common case in practice, and why the first shipped reveal
        // often never played): find the committed line that replaced the
        // marker's line by token overlap and reveal that WHOLE line. Still
        // a verbatim slice of committed text, never a guess.
        const reveal =
          anchorReplacement(nextMd, tail, head) ??
          lineFallback(prevMd, nextMd, m.start, m.end);
        if (!reveal) continue;
        // Dedupe: two markers resolved on the same line fall back to the
        // same span; reveal it once.
        if (
          out.some(
            (r) =>
              r.doc === slug &&
              r.section === sid &&
              r.nextStart === reveal.start &&
              r.nextEnd === reveal.end
          )
        )
          continue;
        out.push({
          doc: slug,
          section: sid,
          excerpt: m.excerpt,
          oldMarkerText: prevMd.slice(m.start, m.end),
          nextStart: reveal.start,
          nextEnd: reveal.end,
        });
      }
    }
  }
  return out;
}

/** Locate the replacement span between the anchors in the committed text.
 *  Null on any ambiguity; the caller then shows no reveal for that item. */
function anchorReplacement(
  nextMd: string,
  tail: string,
  head: string
): { start: number; end: number } | null {
  const t = tail.trimStart();
  const h = head.trimEnd();
  if (t.trim().length < 10) return null; // marker owned its line: no anchor
  const i = nextMd.indexOf(t);
  if (i === -1 || nextMd.indexOf(t, i + 1) !== -1) return null; // missing or ambiguous
  const start = i + t.length;
  let end: number;
  if (h.trim().length >= 4) {
    const j = nextMd.indexOf(h, start);
    if (j === -1) return null;
    end = j;
  } else {
    // Marker sat at end of line: the replacement runs to the line end.
    const nl = nextMd.indexOf("\n", start);
    end = nl === -1 ? nextMd.length : nl;
  }
  if (end < start) return null;
  const slice = nextMd.slice(start, end);
  if (slice.length > SLICE_MAX) return null;
  if (slice.includes("\n")) return null; // cross-line: not an inline reveal
  if (countConfirmMarkers(slice) > 0) return null; // reworded marker inside
  return { start, end };
}

const LINE_MAX = 360;
const LINE_MIN_SIMILARITY = 0.34;

/** Meaningful tokens of a line: lowercased words of >=3 chars. */
function tokenSet(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).values());
}

/**
 * Tier-2 reveal: the committed line that replaced the marker's line, found
 * by token overlap against the OLD line's non-marker text. Guards: at least
 * 3 old tokens to compare against (else everything matches), >=34% overlap,
 * candidate is a plain prose/list line (table rows are excluded: a
 * partially typed row renders as a broken paragraph mid-reveal), carries no
 * marker, and is 8..360 chars. The reveal strips a leading list/heading
 * marker so structure never types itself.
 */
function lineFallback(
  prevMd: string,
  nextMd: string,
  markerStart: number,
  markerEnd: number
): { start: number; end: number } | null {
  const { ls, le } = lineBounds(prevMd, markerStart, markerEnd);
  const oldTokens = tokenSet(
    prevMd.slice(ls, markerStart) + " " + prevMd.slice(markerEnd, le)
  );
  if (oldTokens.size < 3) return null;
  let best: { start: number; end: number; score: number } | null = null;
  let offset = 0;
  for (const line of nextMd.split("\n")) {
    const start = offset;
    offset += line.length + 1;
    const trimmed = line.trim();
    if (trimmed.length < 8 || line.length > LINE_MAX) continue;
    if (trimmed.startsWith("|")) continue; // table row: no partial typing
    if (countConfirmMarkers(line) > 0) continue;
    const tokens = tokenSet(line);
    let overlap = 0;
    for (const t of oldTokens) if (tokens.has(t)) overlap += 1;
    const score = overlap / oldTokens.size;
    if (score >= LINE_MIN_SIMILARITY && (!best || score > best.score)) {
      const lead = /^(\s*(?:#{1,4}|[-*]|\d{1,3}[.)])\s+)/.exec(line);
      best = {
        start: start + (lead ? lead[1].length : 0),
        end: start + line.length,
        score,
      };
    }
  }
  return best ? { start: best.start, end: best.end } : null;
}
