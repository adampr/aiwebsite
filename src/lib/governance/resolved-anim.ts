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

const MAX_REVEALS = 20;
const ANCHOR_MAX = 40;
const SLICE_MAX = 300;

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
        const reveal = anchorReplacement(nextMd, tail, head);
        if (!reveal) continue;
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
