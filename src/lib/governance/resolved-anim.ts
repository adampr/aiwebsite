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

/** How an item plays. "inline" (or absent, for items minted before the
 *  field existed) = the anchored strike-and-type theater over one verbatim
 *  span. "region" = the guaranteed-motion floor when no span could be
 *  anchored honestly: the changed lines wash as a block, nothing types,
 *  and the claim shrinks to "this section's open item cleared" (which the
 *  marker-count delta proved). */
export type RevealKind = "inline" | "region";

export interface ResolvedMarkerReveal {
  doc: string;
  section: string;
  excerpt: string;
  /** The literal old marker text, for the strike-out beat. "" on region
   *  items: there is no anchored place to strike it, the show bar names
   *  the removed marker instead (via excerpt). */
  oldMarkerText: string;
  /** Span of the replacement in the section's COMMITTED post-turn markdown.
   *  An empty span (start === end) means the marker was simply deleted.
   *  Region items span the section's changed-line block instead. */
  nextStart: number;
  nextEnd: number;
  /** Absent = "inline" (items minted before the field, and every anchored
   *  reveal). Checked by isRevealShape on the cross-tab wire. */
  kind?: RevealKind;
}

export function isRegionItem(r: ResolvedMarkerReveal): boolean {
  return r.kind === "region";
}

export const MAX_REVEALS = 20;
const ANCHOR_MAX = 40;
const SLICE_MAX = 300;

/** Transport guard for cross-tab reveal broadcasts (workspace.tsx): true
 *  only for a plausible ResolvedMarkerReveal. Span sanity against the
 *  receiving tab's actual markdown stays at render time (decorateMarkdown
 *  drops out-of-range offsets); this only rejects junk shapes. kind is
 *  closed-world: unknown kinds are rejected so a future bundle's new kind
 *  never plays through this bundle's runner as something it is not.
 *  (The channel itself is versioned too - see workspace.tsx.) */
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
    (r.nextEnd as number) >= (r.nextStart as number) &&
    (r.kind === undefined || r.kind === "inline" || r.kind === "region")
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

/** Region hold: long enough for the washed block to register as "this
 *  moved", never longer than a typed item would have taken. */
export function regionHoldMs(len: number): number {
  return Math.min(3200, Math.max(1800, len * 6));
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
  if (isRegionItem(item)) {
    // Region beats (runShowStep region branch): optional section jump,
    // then wash-on + center (120 + 180), then the hold. The two constants
    // sum to the 300 here - change them together.
    return (reduce ? 0 : sameSection ? 60 : 420) + 300 + regionHoldMs(len);
  }
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
      // A marker the tiers cannot anchor still resolved; it feeds the
      // section's region floor below instead of vanishing silently.
      let sectionInline = false;
      let firstUnanchored: string | null = null;
      for (const m of before) {
        if (out.length >= MAX_REVEALS) break;
        const remaining = afterCounts.get(m.excerpt) ?? 0;
        // The last (b - a) occurrences of this excerpt are the resolved ones.
        if (m.occurrence < remaining) continue;
        const { ls, le } = lineBounds(prevMd, m.start, m.end);
        // Markers on table rows never anchor: typing part of a row (or
        // striking across a cell boundary) renders a broken table
        // mid-reveal. The region floor carries them.
        if (prevMd.slice(ls, le).trimStart().startsWith("|")) {
          firstUnanchored ??= m.excerpt;
          continue;
        }
        const tail = tailAnchor(prevMd.slice(ls, m.start));
        const head = headAnchor(prevMd.slice(m.end, le));
        // Tier 1: exact context anchors (the fact was folded in place).
        // Tier 2: the model REWROTE the sentence while folding the fact in
        // (the common case in practice, and why the first shipped reveal
        // often never played): find the committed SENTENCE that replaced
        // the marker's sentence by guarded token overlap. Still a verbatim
        // slice of committed text, never a guess; anything ambiguous
        // degrades to the region floor.
        const reveal =
          anchorReplacement(nextMd, tail, head) ??
          sentenceFallback(prevMd, nextMd, m.start, m.end);
        if (!reveal) {
          firstUnanchored ??= m.excerpt;
          continue;
        }
        // Dedupe: two markers resolved on the same line fall back to the
        // same span; reveal it once (the span still played, so this does
        // NOT feed the region floor).
        if (
          out.some(
            (r) =>
              r.doc === slug &&
              r.section === sid &&
              r.nextStart === reveal.start &&
              r.nextEnd === reveal.end
          )
        ) {
          sectionInline = true;
          continue;
        }
        out.push({
          doc: slug,
          section: sid,
          excerpt: m.excerpt,
          oldMarkerText: prevMd.slice(m.start, m.end),
          nextStart: reveal.start,
          nextEnd: reveal.end,
        });
        sectionInline = true;
      }
      // Region floor (guaranteed motion): resolved markers that no tier
      // could anchor wash the section's changed-line block instead of
      // playing nothing. One region per section; suppressed when the
      // section already plays an inline item (double-claiming the same
      // text would over-assert), and abstains entirely when the changed
      // block still carries a marker (a reworded marker is a NEW open
      // item; washing it as a resolution would lie).
      if (
        !sectionInline &&
        firstUnanchored !== null &&
        out.length < MAX_REVEALS
      ) {
        const region = changedLineRegion(prevMd, nextMd);
        if (region) {
          out.push({
            doc: slug,
            section: sid,
            excerpt: firstUnanchored,
            oldMarkerText: "",
            nextStart: region.start,
            nextEnd: region.end,
            kind: "region",
          });
        }
      }
    }
  }
  return out;
}

/** Per-section resolved-marker counts for the persistent "cleared" chip,
 *  keyed "slug#sid". Count-delta honest by construction (the same lenient
 *  count the receipts use): it needs no anchoring, so the chip survives
 *  every case where the theater degrades or is skipped. */
export function clearedSectionCounts(
  prevDocs: GovernanceDoc[],
  nextDocs: GovernanceDoc[],
  changedSections: Record<string, string[]>
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [slug, secs] of Object.entries(changedSections)) {
    const pd = prevDocs.find((d) => d.slug === slug);
    const nd = nextDocs.find((d) => d.slug === slug);
    if (!pd || !nd) continue;
    for (const sid of secs) {
      const prevMd = pd.sections.find((s) => s.id === sid)?.markdown;
      const nextMd = nd.sections.find((s) => s.id === sid)?.markdown;
      if (prevMd === undefined || nextMd === undefined) continue;
      const delta =
        countConfirmMarkers(prevMd) - countConfirmMarkers(nextMd);
      if (delta > 0) out[`${slug}#${sid}`] = delta;
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
  // The span landed on a table row (a paragraph became a row, or the
  // anchors matched inside one): striking or typing there breaks the row
  // mid-reveal. Degrade to the region floor.
  const { ls: sls, le: sle } = lineBounds(nextMd, start, end);
  if (nextMd.slice(sls, sle).trimStart().startsWith("|")) return null;
  return { start, end };
}

/** Meaningful tokens of a line: lowercased words of >=3 chars. */
function tokenSet(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).values());
}

const SENT_MIN = 8;
const SENT_MAX = 360;
const SENT_MIN_SIM = 0.5;
const SENT_MARGIN = 0.15;
const LEAD_RE = /^(\s*(?:#{1,4}|[-*]|\d{1,3}[.)])\s+)/;

/**
 * Sentence spans of one line, absolute offsets, whitespace-trimmed at both
 * edges (never punctuation: a whole-line single sentence keeps its terminal
 * period, which older pinned tests rely on). A boundary is [.!?], optional
 * closing quote/paren, whitespace, then an upper/digit/quote/paren opener.
 * Never splits when the "." follows a 1-2 letter word ("e.g.", "i.e.") or
 * sits between digits ("3.1"). Forward scan, no regex lookbehind (client-
 * safe file, older engines must parse it). Missed splits are safe: a
 * bigger span is still a verbatim slice.
 */
export function sentenceSpans(
  line: string,
  base: number
): { start: number; end: number }[] {
  const raw: { start: number; end: number }[] = [];
  let start = 0;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "." || ch === "!" || ch === "?") {
      let j = i + 1;
      while (j < line.length && (line[j] === '"' || line[j] === "'" || line[j] === ")")) {
        j += 1;
      }
      let k = j;
      while (k < line.length && (line[k] === " " || line[k] === "\t")) k += 1;
      const opensNew = k > j && k < line.length && /[A-Z0-9"'(]/.test(line[k]);
      let guarded = false;
      if (ch === ".") {
        const before = i > 0 ? line[i - 1] : "";
        const after = j < line.length ? line[j] : "";
        if (/\d/.test(before) && /\d/.test(after)) guarded = true;
        let w = i - 1;
        while (w >= 0 && /[A-Za-z]/.test(line[w])) w -= 1;
        const wordLen = i - 1 - w;
        if (wordLen >= 1 && wordLen <= 2) guarded = true;
      }
      if (opensNew && !guarded) {
        raw.push({ start, end: j });
        start = k;
        i = k;
        continue;
      }
    }
    i += 1;
  }
  if (start < line.length) raw.push({ start, end: line.length });
  const out: { start: number; end: number }[] = [];
  for (const s of raw) {
    let a = s.start;
    let b = s.end;
    while (a < b && (line[a] === " " || line[a] === "\t")) a += 1;
    while (b > a && (line[b - 1] === " " || line[b - 1] === "\t")) b -= 1;
    if (b > a) out.push({ start: base + a, end: base + b });
  }
  return out;
}

/**
 * Tier-2 reveal: the committed SENTENCE that replaced the marker's
 * sentence, found by guarded token overlap. Replaces the old whole-line
 * fallback, whose 360-char line cap silently excluded most real policy
 * paragraphs (they are one markdown line) and whose margin-free best-pick
 * could type an unrelated line on a full-section rewrite. Guards, in
 * order: the old sentence context must carry >=3 meaningful tokens;
 * candidates are sentence spans of non-table lines, 8..360 chars,
 * marker-free, lead-stripped, and NOT text that already existed before
 * the turn (unchanged text cannot be the replacement); a candidate needs
 * >=50% token overlap AND >=2 matched tokens of length >=4 (or 75%
 * overlap); the winner needs a 0.15 score margin over the best different-
 * text rival, else one positional tie-break (the sole contender within
 * 10% relative document offset of the old sentence), else NO reveal (the
 * region floor takes over). Ambiguity degrades, never guesses.
 */
function sentenceFallback(
  prevMd: string,
  nextMd: string,
  markerStart: number,
  markerEnd: number
): { start: number; end: number } | null {
  const { ls, le } = lineBounds(prevMd, markerStart, markerEnd);
  // Old sentence context: every sentence span the marker touches, merged
  // (a marker can straddle a false boundary from its own punctuation).
  let os = markerStart;
  let oe = markerEnd;
  for (const s of sentenceSpans(prevMd.slice(ls, le), ls)) {
    if (s.start < markerEnd && s.end > markerStart) {
      os = Math.min(os, s.start);
      oe = Math.max(oe, s.end);
    }
  }
  const oldTokens = tokenSet(
    prevMd.slice(os, markerStart) + " " + prevMd.slice(markerEnd, oe)
  );
  if (oldTokens.size < 3) return null;
  const oldRel = markerStart / Math.max(1, prevMd.length);

  type Cand = { start: number; end: number; text: string; score: number };
  const cands: Cand[] = [];
  let offset = 0;
  for (const line of nextMd.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1;
    const trimmed = line.trim();
    if (trimmed.length < SENT_MIN) continue;
    if (trimmed.startsWith("|")) continue; // table row: no partial typing
    const lead = LEAD_RE.exec(line);
    const leadLen = lead ? lead[1].length : 0;
    for (const sp of sentenceSpans(line.slice(leadLen), lineStart + leadLen)) {
      const text = nextMd.slice(sp.start, sp.end);
      if (text.length < SENT_MIN || text.length > SENT_MAX) continue;
      if (countConfirmMarkers(text) > 0) continue;
      if (prevMd.includes(text)) continue; // predates the turn
      const tokens = tokenSet(text);
      let overlap = 0;
      let matched4 = 0;
      for (const t of oldTokens)
        if (tokens.has(t)) {
          overlap += 1;
          if (t.length >= 4) matched4 += 1;
        }
      const score = overlap / oldTokens.size;
      if (score < SENT_MIN_SIM) continue;
      if (matched4 < 2 && score < 0.75) continue; // distinctiveness floor
      cands.push({ start: sp.start, end: sp.end, text, score });
    }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.score - a.score); // stable: ties keep doc order
  const best = cands[0];
  const rival = cands.find((c) => c.text !== best.text);
  if (rival && best.score - rival.score < SENT_MARGIN) {
    const near = cands.filter(
      (c) =>
        Math.abs(c.start / Math.max(1, nextMd.length) - oldRel) <= 0.1
    );
    if (near.length === 1) return { start: near[0].start, end: near[0].end };
    return null; // ambiguous: the region floor is the honest answer
  }
  return { start: best.start, end: best.end };
}

/**
 * The committed changed-line block of a section: strip common exact prefix
 * lines and common exact suffix lines (suffix never re-consumes prefix
 * lines), then shrink the edges past marker-bearing lines. Returns the
 * char span of what remains in nextMd; an empty span at the seam for a
 * pure deletion; null when nothing changed or when the block still
 * carries a [TO CONFIRM] marker (a reworded marker is a NEW open item,
 * washing it as a resolution would lie - the caller then shows nothing,
 * matching the count receipts).
 */
export function changedLineRegion(
  prevMd: string,
  nextMd: string
): { start: number; end: number } | null {
  if (prevMd === nextMd) return null;
  const prevLines = prevMd.split("\n");
  const nextLines = nextMd.split("\n");
  const maxCommon = Math.min(prevLines.length, nextLines.length);
  let pre = 0;
  while (pre < maxCommon && prevLines[pre] === nextLines[pre]) pre += 1;
  let suf = 0;
  while (
    suf < maxCommon - pre &&
    prevLines[prevLines.length - 1 - suf] ===
      nextLines[nextLines.length - 1 - suf]
  )
    suf += 1;
  const starts: number[] = [];
  let acc = 0;
  for (const l of nextLines) {
    starts.push(acc);
    acc += l.length + 1;
  }
  let lo = pre;
  let hi = nextLines.length - suf;
  if (lo >= hi) {
    // Pure deletion: nothing new stands where the old lines were.
    const at = starts[Math.min(lo, nextLines.length - 1)] ?? 0;
    return { start: at, end: at };
  }
  while (lo < hi && countConfirmMarkers(nextLines[lo]) > 0) lo += 1;
  while (hi > lo && countConfirmMarkers(nextLines[hi - 1]) > 0) hi -= 1;
  if (lo >= hi) return null; // only marker lines changed: abstain
  const start = starts[lo];
  const end = starts[hi - 1] + nextLines[hi - 1].length;
  if (countConfirmMarkers(nextMd.slice(start, end)) > 0) return null;
  return { start, end };
}

/**
 * Structure-safe wash spans for a region: one span per non-blank line
 * overlapped by [start, end), lead-stripped, with table rows and dividers
 * skipped entirely (a sentinel before "|" or across cells breaks row
 * parsing). May return [] (all-table or all-blank region): the renderer
 * then falls back to the section-level pulse class, which is the static
 * signal too.
 */
export function regionWashLines(
  md: string,
  start: number,
  end: number
): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let offset = 0;
  for (const line of md.split("\n")) {
    const ls = offset;
    const le = offset + line.length;
    offset = le + 1;
    if (le <= start) continue;
    if (ls >= end) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("|")) continue;
    if (countConfirmMarkers(line) > 0) continue; // defense in depth
    const lead = LEAD_RE.exec(line);
    const s = Math.max(ls + (lead ? lead[1].length : 0), start);
    const e = Math.min(le, end);
    if (e > s) out.push({ start: s, end: e });
  }
  return out;
}
