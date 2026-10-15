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
  /** Index of the paragraph within its section's stored paragraphs array;
   *  -1 for a table member (blockId set). */
  paragraph: number;
  /** First 160 chars of the ORIGINAL (un-normalized) paragraph text, or of
   *  the table's serialized text without its `[visual …]` tag. */
  excerpt: string;
  /** Set only on a table member: the block's id, so the review turn can name it. */
  blockId?: string;
};

/** A section's visual block as the caller serialized it (draft-blocks.ts
 *  serializeBlockForPrompt). Passed pre-serialized so this module never
 *  imports draft-blocks: both stay client-safe and the graph stays acyclic. */
export type ScanBlock = { id: string; kind: string; text: string };

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
const ROW_KEYS_MIN_SHARED = 3;
/** draft-blocks.ts's stored block id shape, restated (no import, see ScanBlock). */
const BLOCK_ID = /^v_[0-9a-f]{8}$/;

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
  blockId?: string;
  /** Table members only: see tableRows. */
  rows?: Map<string, Set<string>>;
  original: string;
  shingles: Set<string>;
};

/**
 * A serialized block's text without its leading `[visual <kind> id=…]` tag,
 * newlines flattened to " / " so an excerpt stays on its findings line. The
 * tag is the block's identity, not its content: two copies of one table
 * carry different ids and must still read as the same words.
 */
function blockContent(text: string): string {
  const s = text.startsWith("[visual ") && text.indexOf("]") > 0
    ? text.slice(text.indexOf("]") + 1)
    : text;
  return s.trim().replace(/\s*\n\s*/g, " / ");
}

/** Function words two value cells can share without saying the same thing. */
const ROW_VALUE_STOP = new Set([
  "a", "an", "and", "or", "the", "of", "to", "in", "on", "for", "with",
  "by", "at", "as", "from", "per", "is", "are", "be", "no", "not",
]);

/**
 * A serialized table's rows: row key -> the words of the row's other cells.
 * The key is the first cell's words, normalized, distinct and sorted
 * ("Ticketing and PSA" and "PSA and ticketing" are one key); the value words
 * are normalized, function words out. Positional, by serializeBlockForPrompt's
 * fixed layout: line 1 is the tag (a caption rides on it), line 2 the header
 * (never a key), every later line one row.
 */
function tableRows(text: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const row of text.split("\n").slice(2)) {
    const cells = row.split(" | ");
    const words = normalizeParagraph(cells[0]).split(" ").filter(Boolean);
    if (!words.length) continue;
    const key = [...new Set(words)].sort().join(" ");
    const values = out.get(key) ?? new Set<string>();
    for (const w of normalizeParagraph(cells.slice(1).join(" ")).split(" "))
      if (w && !ROW_VALUE_STOP.has(w)) values.add(w);
    out.set(key, values);
  }
  return out;
}

/**
 * Deterministic near-duplicate scan ACROSS sections (and, for two tables
 * only, within one).
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
 *
 * A section's `table` blocks (pre-serialized, see ScanBlock) enter the scan
 * too, after its paragraphs, as members with `paragraph: -1` and `blockId`:
 * a table repeated across sections is the same duplication as a repeated
 * paragraph, and a table can match prose; two tables also match on their
 * row keys (see the table pass below). Other kinds stay out (the system
 * kinds are one per document by origin; references hold contacts). With no
 * blocks passed, the result is exactly the paragraph-only scan.
 *
 * The same-section exception (§5.17.16): two TABLE entries may match inside
 * one section, by the row-key + content-agreement table test ONLY, because
 * one section holding the same table twice is duplication a reader sees at
 * once. The shingle test stays strictly cross-section: it checks no content
 * agreement, so same-section tables sharing only long row keys would match
 * on the keys alone. Every pair with a paragraph in it still needs two
 * sections: adjacent prose legitimately elaborates, and a paragraph beside
 * its own table is the normal lead-in, not a copy.
 */
export function findDuplicateClusters(
  sections: {
    label: string;
    title: string;
    paragraphs: string[];
    blocks?: ScanBlock[];
  }[]
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
    for (const b of Array.isArray(s.blocks) ? s.blocks : []) {
      // The id is printed into a prompt line: only the stored id shape passes.
      if (!b || b.kind !== "table" || typeof b.text !== "string" || !BLOCK_ID.test(String(b.id))) continue;
      const content = blockContent(b.text);
      const words = normalizeParagraph(content).split(" ").filter(Boolean);
      if (words.length < MIN_WORDS) continue;
      entries.push({
        id: entries.length,
        sectionIndex,
        label: s.label,
        paragraph: -1,
        blockId: b.id,
        rows: tableRows(b.text),
        original: content,
        shingles: shingleSet(words),
      });
    }
  });

  // Inverted index: shingle -> entry ids (ascending by construction).
  const index = new Map<string, number[]>();
  for (const e of entries)
    for (const sh of e.shingles) {
      const posting = index.get(sh);
      if (posting) posting.push(e.id);
      else index.set(sh, [e.id]);
    }

  // Union-find over entries. The shingle pass unions cross-section pairs
  // only; the table pass below is the one place a same-section pair unions.
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
      // Strictly cross-section, tables included: this test checks no content
      // agreement (the same-section exception lives in the table pass only).
      if (other.sectionIndex === e.sectionIndex) continue;
      const denom = Math.min(e.shingles.size, other.shingles.size);
      if (denom > 0 && count / denom >= DUP_THRESHOLD) union(e.id, j);
    }
  }

  // Table against table: the same rows under different notes columns or in
  // a different order share almost no 8-gram (the three Curioso "Central
  // services" tables measured 0.02 to 0.10), so two tables in different
  // sections are also duplicates when their row keys reach the same 0.5
  // containment with at least 3 keys shared, AND the rows agree on content:
  // in at least half of the shared keys the two rows' other cells share a
  // word ("Barracuda", "Kaseya"). Keys alone are not content: a "Service |
  // Included" table and a "Service | Response target" table list the same
  // services and say different things. Two tables in ONE section are tested
  // here too (the same-section exception), and ONLY here: this is the test
  // that checks content agreement. Only table entries carry
  // `rows`, so with no blocks passed this pass does nothing.
  const tables = entries.filter((e) => e.rows !== undefined);
  for (let a = 0; a < tables.length; a++)
    for (let b = a + 1; b < tables.length; b++) {
      const x = tables[a];
      const y = tables[b];
      let common = 0;
      let agree = 0;
      for (const [k, xs] of x.rows!) {
        const ys = y.rows!.get(k);
        if (!ys) continue;
        common++;
        for (const w of xs)
          if (ys.has(w)) {
            agree++;
            break;
          }
      }
      const denom = Math.min(x.rows!.size, y.rows!.size);
      if (
        common >= ROW_KEYS_MIN_SHARED &&
        common / denom >= DUP_THRESHOLD &&
        agree * 2 >= common
      )
        union(x.id, y.id);
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
        ...(m.blockId !== undefined ? { blockId: m.blockId } : {}),
      })),
      excerpt: c.members[0].original.slice(0, EXCERPT_CHARS),
    };
  });
}

/** One findings line. A cluster with table members names each table by its
 *  id, so the review turn sees a TABLE (which it can prune by that id), not
 *  prose; a text-only cluster reads exactly as it always has. A cluster of
 *  tables in one section reads "appears twice in <title> (id v_a, id v_b)". */
function findingsLine(
  c: DuplicateCluster,
  displayTitle: (label: string) => string
): string {
  const tables = c.members.filter((m) => m.blockId !== undefined);
  if (tables.length === 0)
    return `- The same passage appears in ${c.labels
      .map((l) => displayTitle(l))
      .join(", ")}: "${c.excerpt}"`;
  const textLabels: string[] = [];
  for (const m of c.members)
    if (m.blockId === undefined && !textLabels.includes(m.label))
      textLabels.push(m.label);
  // Tables only, all in ONE section (the same-section exception): the title
  // once, every id after it. Any other shape reads as it always has.
  if (textLabels.length === 0 && tables.every((m) => m.label === tables[0].label))
    return `- The same table appears ${
      tables.length === 2 ? "twice" : `${tables.length} times`
    } in ${displayTitle(tables[0].label)} (${tables
      .map((m) => `id ${m.blockId}`)
      .join(", ")}): "${c.excerpt}"`;
  if (textLabels.length === 0)
    return `- The same table appears in ${tables
      .map((m) => `${displayTitle(m.label)} (id ${m.blockId})`)
      .join(", ")}: "${c.excerpt}"`;
  return `- The same content appears as text in ${textLabels
    .map((l) => displayTitle(l))
    .join(", ")} and as ${tables
    .map((m) => `the table (id ${m.blockId}) in ${displayTitle(m.label)}`)
    .join(", ")}: "${c.excerpt}"`;
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
    const line = findingsLine(c, displayTitle);
    const spend = line.length + (kept.length ? 1 : 0);
    if (total + spend > FINDINGS_MAX_CHARS) break;
    kept.push(line);
    total += spend;
  }
  return kept.join("\n");
}

/**
 * Every table id in any cluster: the scan guard for a "prune-visual" target.
 * The review turn may only remove a block the deterministic scan itself found
 * duplicated, whatever id the model names.
 */
export function clusterBlockIds(clusters: DuplicateCluster[]): Set<string> {
  const out = new Set<string>();
  for (const c of clusters)
    for (const m of c.members) if (m.blockId !== undefined) out.add(m.blockId);
  return out;
}

/**
 * The scan guard a "prune-visual" target answers to (§5.17.16), built from
 * the same clusters the findings were formatted from.
 */
export type PruneGuard = {
  /** blockId -> index of the cluster holding it. The keys are the ONLY ids
   *  a prune may name (clusterBlockIds). */
  clusterOf: Map<string, number>;
  /** Members per cluster (paragraphs and tables), by cluster index. */
  members: number[];
};

export function pruneGuard(clusters: DuplicateCluster[]): PruneGuard {
  const clusterOf = new Map<string, number>();
  clusters.forEach((c, i) => {
    for (const m of c.members)
      if (m.blockId !== undefined) clusterOf.set(m.blockId, i);
  });
  return { clusterOf, members: clusters.map((c) => c.members.length) };
}

/**
 * Admits the prune-visual targets of ONE review answer, in answer order. A
 * prune is admitted only when the label is not reserved ("__"), the id has
 * the stored block id shape, the scan put that id in a cluster (THE SCAN
 * GUARD: a hostile or invented id removes nothing), the block sits on that
 * section, and at least one other member of its cluster survives the prunes
 * already admitted in this answer: first named, first pruned, so a review
 * that names every copy keeps the last one. Returns the admitted id,
 * or null (the caller downgrades the target to "revise").
 */
export function pruneAdmitter(
  guard: PruneGuard
): (label: string, blockId: unknown, blocksOnSection: readonly string[] | undefined) => string | null {
  const pruned = new Map<number, number>();
  return (label, blockId, blocksOnSection) => {
    const id = typeof blockId === "string" ? blockId.trim() : "";
    if (label.startsWith("__") || !BLOCK_ID.test(id)) return null;
    const cluster = guard.clusterOf.get(id);
    if (cluster === undefined) return null;
    if (!Array.isArray(blocksOnSection) || !blocksOnSection.includes(id)) return null;
    const after = (pruned.get(cluster) ?? 0) + 1;
    if (after >= (guard.members[cluster] ?? 0)) return null;
    pruned.set(cluster, after);
    return id;
  };
}

/**
 * The consolidation review's deterministic half, from sections whose
 * visuals the caller already serialized (brain.ts prepareConsolidationReview
 * for the route and the rfp:consolidate CLI): the duplicate clusters, their
 * findings lines (display title = label and title joined; the letter, never
 * in a cluster, by its title) and the prune guard.
 */
export function consolidationScan(
  sections: {
    label: string;
    title: string;
    paragraphs: string[];
    blocks?: ScanBlock[];
  }[]
): { clusters: DuplicateCluster[]; findings: string; guard: PruneGuard } {
  const clusters = findDuplicateClusters(sections);
  const titleByLabel = new Map(
    sections.map((s) => [
      s.label,
      s.label === LETTER_LABEL ? s.title : `${s.label} ${s.title}`.trim(),
    ])
  );
  const findings = formatDuplicateFindings(
    clusters,
    (l) => titleByLabel.get(l) ?? l
  );
  return { clusters, findings, guard: pruneGuard(clusters) };
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
