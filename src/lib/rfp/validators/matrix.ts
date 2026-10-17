/**
 * The questionnaire response matrix, as the gate and Coverage read it (§5.17.22, round 34 Q1e).
 *
 * A section of a real RFP whose requirements carry the client's own item IDs (`clientRef`) is
 * answered as a matrix: one row per ID, in the client's order, each with a verdict pill. The rows
 * are HOST-built (resolve-draft lifts the section's stored answers into a `response-matrix` block in
 * requirement ordinal order); the model never writes the block. This module is the one reader of
 * that block for the gate (rules D7/D8/D9 in rules-d.ts) and for Coverage (`withMatrixCoverage`,
 * the post-pass over resolve-draft's coverage computation), so the two can never disagree about
 * which IDs have a row.
 *
 * CLIENT-SAFE by contract, unlike the rules files (rules-d.ts carries a lookbehind): pure, type-only
 * imports, no lookbehind, so the workspace's Coverage pane may import `matrixRowGaps` to read the
 * same answer the gate reads. Every reader is total over hostile stored shapes (a row that is not an
 * object, a non-string ref, a block with no rows array): it degrades, it never throws, because it
 * runs on every gate run and on every render of the pane.
 */

import type { RequirementCoverage } from "@/lib/rfp/content-model";
import { isQuestionnaireSection, questionnaireRefs, sanitizeClientRef } from "@/lib/rfp/outline";

/** The verdict enum the matrix prints as pills. Anything else is a corrupt row (rule D9). */
export const MATRIX_VERDICTS = ["yes", "partial", "no", "na"] as const;

/** True for one of the four verdicts (content-model/blocks.ts MatrixVerdict is the same union). */
export function isMatrixVerdict(v: unknown): v is (typeof MATRIX_VERDICTS)[number] {
  return typeof v === "string" && (MATRIX_VERDICTS as readonly string[]).includes(v);
}

/** The block kind resolve-draft lifts the stored answers into (content-model/blocks.ts). */
export const RESPONSE_MATRIX_KIND = "response-matrix";

/** The requirement fields this module reads. `clientRef` is optional and read loosely: a row
 *  stored before migration 0064 has none, and a hostile value is treated as none. */
export type RefRequirement = {
  id: string;
  structureLabel: string;
  ordinal: number;
  clientRef?: unknown;
};

/**
 * The requirement's client item ID, or null. THE reader's sanitizer (outline.ts
 * sanitizeClientRef), so the gate, Coverage and the drafter agree on what counts as a ref.
 */
export function clientRefOf(r: { clientRef?: unknown } | null | undefined): string | null {
  return sanitizeClientRef(r?.clientRef);
}

/**
 * The structure labels that are questionnaire-mode, by THE predicate (outline.ts
 * isQuestionnaireSection: at least QUESTIONNAIRE_MIN_REFS distinct client refs). Derived, never
 * stored, so a re-read stays coherent.
 */
export function questionnaireLabels(
  requirements: readonly { structureLabel: string; clientRef?: unknown }[]
): Set<string> {
  const list = Array.isArray(requirements) ? requirements : [];
  const labels = new Set<string>();
  for (const r of list) if (r && typeof r.structureLabel === "string") labels.add(r.structureLabel);
  const out = new Set<string>();
  for (const label of labels) if (isQuestionnaireSection(list, label)) out.add(label);
  return out;
}

/**
 * The distinct refs of one structure node in the CLIENT's order (outline.ts questionnaireRefs:
 * ordinal ascending, ties in input order, each ref at its first appearance; one numbered ask
 * split into several atomic requirements is answered once).
 */
export function refsInClientOrder(requirements: readonly RefRequirement[], label: string): string[] {
  return questionnaireRefs(Array.isArray(requirements) ? requirements : [], label);
}

/** One stored matrix row with where it sits: the block that carries it and its index there. */
export type LocatedMatrixRow = { row: unknown; blockId: string | undefined; index: number };

/**
 * Every response-matrix row in a section's blocks, in flow order. Normally one block per section;
 * more than one is read as one sequence (block order, then row order) rather than refused.
 */
export function matrixRowsIn(section: { blocks?: unknown } | null | undefined): LocatedMatrixRow[] {
  const blocks = Array.isArray(section?.blocks) ? (section!.blocks as unknown[]) : [];
  const out: LocatedMatrixRow[] = [];
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    const block = b as { kind?: unknown; id?: unknown; rows?: unknown };
    if (block.kind !== RESPONSE_MATRIX_KIND) continue;
    const blockId = typeof block.id === "string" ? block.id : undefined;
    const rows = Array.isArray(block.rows) ? block.rows : [];
    rows.forEach((row, index) => out.push({ row, blockId, index }));
  }
  return out;
}

/** True when the section carries a response-matrix block at all (even an empty one). */
export function hasMatrixBlock(section: { blocks?: unknown } | null | undefined): boolean {
  const blocks = Array.isArray(section?.blocks) ? (section!.blocks as unknown[]) : [];
  return blocks.some(
    (b) => !!b && typeof b === "object" && (b as { kind?: unknown }).kind === RESPONSE_MATRIX_KIND
  );
}

/** A row's ref, trimmed, or null for a row that is not an object or carries no string ref. */
export function rowRefOf(row: unknown): string | null {
  if (!row || typeof row !== "object") return null;
  const ref = (row as { ref?: unknown }).ref;
  if (typeof ref !== "string") return null;
  const t = ref.trim();
  return t ? t : null;
}

/**
 * The requirements that have a client ref in a questionnaire-mode section that IS drafted, but no
 * matrix row for that ref, mapped to the missing ref. `rowsFor(label)` returns the rows a drafted
 * section carries (anything with a `ref`: the resolved block's rows for the gate, the stored
 * `answers` for the pane), or null when the section is not drafted: an undrafted section is
 * already uncovered by the existing computation, so it is left to it. Requirements without refs,
 * and refs on a section that is not questionnaire-mode, are never in the result.
 */
export function matrixRowGaps(
  requirements: readonly RefRequirement[],
  rowsFor: (label: string) => readonly unknown[] | null
): Map<string, string> {
  const gaps = new Map<string, string>();
  for (const label of questionnaireLabels(requirements)) {
    const rows = rowsFor(label);
    if (rows === null || rows === undefined) continue;
    const answered = new Set<string>();
    for (const row of Array.isArray(rows) ? rows : []) {
      const ref = rowRefOf(row);
      if (ref !== null) answered.add(ref);
    }
    for (const r of requirements) {
      if (!r || r.structureLabel !== label) continue;
      const ref = clientRefOf(r);
      if (ref !== null && !answered.has(ref)) gaps.set(r.id, ref);
    }
  }
  return gaps;
}

/** The note a matrix gap carries on its coverage entry. */
export function matrixGapNote(ref: string): string {
  return `No response row for item ${ref}.`;
}

/**
 * The post-pass over resolve-draft's ONE coverage computation (it derives "covered" from a drafted
 * section with content): a requirement with a client ref in a drafted questionnaire-mode section
 * that has no matrix row for that ref is UNCOVERED, with a note naming the ref. Entries for every
 * other requirement pass through untouched, in the same order, so a document with no client refs
 * gets back the identical array (same object identity, byte-identical gate output).
 *
 * Consequence by design (contract Q1e, analyst D1 "a missing ref becomes a Coverage gap"): rule C3
 * reads coverage, so a MANDATORY requirement with no row is also a C3 block beside D7's warn.
 */
export function withMatrixCoverage(
  coverage: RequirementCoverage[],
  requirements: readonly RefRequirement[],
  sections: readonly { id: string; structureLabel: string; blocks?: unknown }[]
): RequirementCoverage[] {
  const byLabel = new Map(sections.map((s) => [s.structureLabel, s]));
  const gaps = matrixRowGaps(requirements, (label) => {
    const sec = byLabel.get(label);
    const blocks = Array.isArray(sec?.blocks) ? (sec!.blocks as unknown[]) : [];
    return sec && blocks.length > 0 ? matrixRowsIn(sec).map((x) => x.row) : null;
  });
  if (gaps.size === 0) return coverage;
  const out = coverage.map((c) => {
    const ref = gaps.get(c.requirementId);
    return ref === undefined ? c : { ...c, state: "uncovered" as const, note: matrixGapNote(ref) };
  });
  // A gap whose requirement had no entry at all (the computation only pushes drafted ones, and
  // matrixRowGaps only reports drafted sections, so this is defensive) gets an explicit one.
  const have = new Set(coverage.map((c) => c.requirementId));
  for (const [requirementId, ref] of gaps) {
    if (have.has(requirementId)) continue;
    const req = requirements.find((r) => r.id === requirementId);
    const sec = req ? byLabel.get(req.structureLabel) : undefined;
    if (!sec) continue;
    out.push({ requirementId, sectionId: sec.id, state: "uncovered", note: matrixGapNote(ref) });
  }
  return out;
}

/**
 * A run-compressed, capped list of refs for a message: consecutive refs in the client's order
 * collapse to "OC-01 to OC-04" (a run of two stays "OC-01, OC-02"), and past `maxParts` parts the
 * rest is counted ("and 9 more"). `order` is the section's refs in client order; refs not in it
 * (defensive) are appended in their given order as single parts.
 */
export function compressRefs(refs: readonly string[], order: readonly string[], maxParts = 8): string {
  const want = new Set(refs);
  const parts: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length >= 3) parts.push(`${run[0]} to ${run[run.length - 1]}`);
    else parts.push(...run);
    run = [];
  };
  for (const ref of order) {
    if (want.has(ref)) run.push(ref);
    else if (run.length) flush();
  }
  if (run.length) flush();
  const known = new Set(order);
  for (const ref of refs) if (!known.has(ref)) parts.push(ref);
  if (parts.length <= maxParts) return parts.join(", ");
  const shown = parts.slice(0, maxParts);
  const hiddenRefs = parts.slice(maxParts).reduce((n, p) => {
    const m = / to /.exec(p);
    if (!m) return n + 1;
    const a = order.indexOf(p.slice(0, m.index));
    const b = order.indexOf(p.slice(m.index + 4));
    return n + (a >= 0 && b >= a ? b - a + 1 : 1);
  }, 0);
  return `${shown.join(", ")} and ${hiddenRefs} more`;
}
