// Whole-document consolidation scan (ARCHITECTURE.md §5.17.16).
//
// Deterministic near-duplicate detection across a drafted RFP response, plus
// the prompt-line builders the consolidation review turn reads. The scan is
// mechanical on purpose: the review turn is TOLD where text repeats, so a
// duplication a reader would notice cannot slip past a model skim, and the
// same clusters count in the route's activity log.
//
// CLIENT-SAFE by contract: imported by workspace.tsx, so no lookbehind
// regexes, no fs, no server imports. letter.ts qualifies (same standing as
// check-fixes.ts, which workspace.tsx already pulls in).

import { LETTER_LABEL } from "./letter";

/** The canned instruction each consolidation revise call carries. The
 *  planner's per-section directive rides alongside it, exactly like the Tron
 *  pane's whole-document loop. */
export const CONSOLIDATE_INSTRUCTION =
  "Consolidate this section as part of a whole-document cleanup: remove or " +
  "merge text that repeats what another section already says, keep each " +
  "point in the one section where the RFP asks for it, and keep this " +
  "section responsive to its own requirements. Keep the meaning, keep the " +
  "facts, and add nothing new.";

export type DupParagraph = {
  label: string;
  /** Index of the paragraph within its section's stored paragraphs array. */
  paragraph: number;
  /** First 160 chars of the ORIGINAL (un-normalized) paragraph text. */
  excerpt: string;
};

export type DuplicateCluster = {
  /** Distinct section labels, in document order. */
  labels: string[];
  /** Every member paragraph, in document order. */
  members: DupParagraph[];
  /** First 160 chars of the original text of the first member. */
  excerpt: string;
};

const MIN_WORDS = 12;
const SHINGLE_WORDS = 8;
const DUP_THRESHOLD = 0.5;
const MAX_CLUSTERS = 12;
const EXCERPT_CHARS = 160;
const FINDINGS_MAX_CHARS = 2400;
const REQ_TEXT_CHARS = 200;
const REQ_DEFAULT_BUDGET = 9000;

/** NFKC, lowercase, letters/digits/spaces only, single-spaced. */
function normalizeParagraph(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Word 8-gram shingle set of a normalized paragraph. */
function shingleSet(words: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE_WORDS <= words.length; i++)
    out.add(words.slice(i, i + SHINGLE_WORDS).join(" "));
  return out;
}

type Entry = {
  id: number;
  sectionIndex: number;
  label: string;
  paragraph: number;
  original: string;
  shingles: Set<string>;
};

/**
 * Deterministic near-duplicate scan ACROSS sections.
 *
 * The letter is skipped (it summarizes sections by design), so are
 * paragraphs under 12 words after normalizing (headers, stubs). Two
 * paragraphs are near-duplicates when the containment of their word 8-gram
 * shingle sets, |A n B| / min(|A|,|B|), reaches 0.5 AND their sections
 * differ; candidates come from an inverted shingle index, never from testing
 * every pair blind, so 80 sections x 12 paragraphs stays cheap. Candidates
 * are union-found into clusters; at most 12 come back, largest first (member
 * count, then total shingle count, then document order), everything ordered
 * deterministically.
 */
export function findDuplicateClusters(
  sections: { label: string; title: string; paragraphs: string[] }[]
): DuplicateCluster[] {
  const entries: Entry[] = [];
  sections.forEach((s, sectionIndex) => {
    if (s.label === LETTER_LABEL) return;
    s.paragraphs.forEach((p, paragraph) => {
      const words = normalizeParagraph(p).split(" ").filter(Boolean);
      if (words.length < MIN_WORDS) return;
      entries.push({
        id: entries.length,
        sectionIndex,
        label: s.label,
        paragraph,
        original: p,
        shingles: shingleSet(words),
      });
    });
  });

  // Inverted index: shingle -> entry ids (ascending by construction).
  const index = new Map<string, number[]>();
  for (const e of entries)
    for (const sh of e.shingles) {
      const posting = index.get(sh);
      if (posting) posting.push(e.id);
      else index.set(sh, [e.id]);
    }

  // Union-find over entries; only cross-section duplicate pairs are unioned.
  const parent = entries.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  for (const e of entries) {
    // Shared-shingle counts against every LATER entry that co-occurs in the
    // index; each unordered pair is therefore tested exactly once.
    const shared = new Map<number, number>();
    for (const sh of e.shingles)
      for (const j of index.get(sh)!) {
        if (j <= e.id) continue;
        shared.set(j, (shared.get(j) ?? 0) + 1);
      }
    for (const [j, count] of shared) {
      const other = entries[j];
      if (other.sectionIndex === e.sectionIndex) continue;
      const denom = Math.min(e.shingles.size, other.shingles.size);
      if (denom > 0 && count / denom >= DUP_THRESHOLD) union(e.id, j);
    }
  }

  const byRoot = new Map<number, Entry[]>();
  for (const e of entries) {
    const root = find(e.id);
    const group = byRoot.get(root);
    if (group) group.push(e);
    else byRoot.set(root, [e]);
  }

  const clusters: { members: Entry[]; totalShingles: number }[] = [];
  for (const members of byRoot.values()) {
    if (members.length < 2) continue;
    // Members already sit in document order (entry ids are insertion order).
    clusters.push({
      members,
      totalShingles: members.reduce((n, m) => n + m.shingles.size, 0),
    });
  }
  clusters.sort(
    (a, b) =>
      b.members.length - a.members.length ||
      b.totalShingles - a.totalShingles ||
      a.members[0].id - b.members[0].id
  );

  return clusters.slice(0, MAX_CLUSTERS).map((c) => {
    const labels: string[] = [];
    for (const m of c.members)
      if (!labels.includes(m.label)) labels.push(m.label);
    return {
      labels,
      members: c.members.map((m) => ({
        label: m.label,
        paragraph: m.paragraph,
        excerpt: m.original.slice(0, EXCERPT_CHARS),
      })),
      excerpt: c.members[0].original.slice(0, EXCERPT_CHARS),
    };
  });
}

/**
 * Prompt lines for the review turn, one per cluster. Capped at 2400 chars by
 * dropping whole trailing lines, never by cutting mid-line; no clusters (or
 * no room for even the first line) is "".
 */
export function formatDuplicateFindings(
  clusters: DuplicateCluster[],
  displayTitle: (label: string) => string
): string {
  const kept: string[] = [];
  let total = 0;
  for (const c of clusters) {
    const line = `- The same passage appears in ${c.labels
      .map((l) => displayTitle(l))
      .join(", ")}: "${c.excerpt}"`;
    const spend = line.length + (kept.length ? 1 : 0);
    if (total + spend > FINDINGS_MAX_CHARS) break;
    kept.push(line);
    total += spend;
  }
  return kept.join("\n");
}

/**
 * Requirement lines for the review turn: mandatory ones first (stable within
 * each group), one line per requirement, text sliced to 200 chars, the whole
 * block capped at `budget` chars (default 9000) without cutting mid-line.
 * When the budget cuts, the last line says how many were left out.
 */
export function requirementLines(
  reqs: {
    structureLabel: string;
    text: string;
    kind: string;
    mandatory: boolean;
  }[],
  budget: number = REQ_DEFAULT_BUDGET
): string {
  const ordered = [
    ...reqs.filter((r) => r.mandatory),
    ...reqs.filter((r) => !r.mandatory),
  ];
  const lines = ordered.map(
    (r) => `- [${r.structureLabel}] ${r.text.slice(0, REQ_TEXT_CHARS)}`
  );
  const kept: string[] = [];
  let total = 0;
  for (const line of lines) {
    const spend = line.length + (kept.length ? 1 : 0);
    if (total + spend > budget) break;
    kept.push(line);
    total += spend;
  }
  if (kept.length < lines.length) {
    let tail = `- (and ${lines.length - kept.length} more requirements)`;
    while (
      kept.length &&
      total + tail.length + 1 > budget
    ) {
      const dropped = kept.pop()!;
      total -= dropped.length + (kept.length ? 1 : 0);
      tail = `- (and ${lines.length - kept.length} more requirements)`;
    }
    if (!kept.length && tail.length > budget) return "";
    kept.push(tail);
  }
  return kept.join("\n");
}
