// Restyle-run batching (§5.12 format pass). Client-safe: pure functions over
// types + config only. The client packs "slug#section" batches from the view
// it has; the SERVER re-derives the safe target set itself (placeholder and
// stub exclusion in turn-runner.ts is the invariant, this is the UX copy).

import { CAPS } from "./config";
import type { GovernanceDoc } from "./types";

/** Every drafted section of every non-stub doc, as "slug#section" refs, in
 *  document order. Placeholder (scaffold) sections are excluded: restyling
 *  scaffold text is wasted spend, and a reworded scaffold would stop
 *  byte-matching the placeholder detector and read as drafted. */
export function restyleTargets(
  documents: GovernanceDoc[],
  placeholderSections: Record<string, string[]>
): string[] {
  const out: string[] = [];
  for (const d of documents) {
    if (d.stub) continue;
    const skip = new Set(placeholderSections[d.slug] ?? []);
    for (const s of d.sections)
      if (!skip.has(s.id)) out.push(`${d.slug}#${s.id}`);
  }
  return out;
}

/** Upload-time reformat-debt rule (§5.12 round 16): a new sample creates
 *  debt ONLY when something already drafted could mismatch it. Anything
 *  drafted after the upload follows the new sample at draft time. */
export function uploadCreatesDebt(
  status: string,
  documents: GovernanceDoc[],
  placeholderSections: Record<string, string[]>
): boolean {
  return (
    (status === "drafting" || status === "review") &&
    restyleTargets(documents, placeholderSections).length > 0
  );
}

/** Greedy packing by the same rewrite estimate the resolver uses: one turn
 *  re-emits every batched section in full, so a batch's inherent cost is the
 *  sum of its sections' current markdown (+200 slack each), kept 1000 chars
 *  below the stated target. The route caps focusSections at 20 refs. */
export function packRestyleBatches(
  documents: GovernanceDoc[],
  refs: string[]
): string[][] {
  const budget = CAPS.turnOpMarkdownTargetChars - 1000;
  const sizeOf = (ref: string): number => {
    const i = ref.indexOf("#");
    const d = documents.find((x) => x.slug === ref.slice(0, i));
    const s = d?.sections.find((x) => x.id === ref.slice(i + 1));
    return (s?.markdown.length ?? 0) + 200;
  };
  const batches: string[][] = [];
  let cur: string[] = [];
  let acc = 0;
  for (const ref of refs) {
    const size = sizeOf(ref);
    if (cur.length && (acc + size > budget || cur.length >= 20)) {
      batches.push(cur);
      cur = [];
      acc = 0;
    }
    cur.push(ref);
    acc += size;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/** Normalized text content of a section's markdown, for the honest final
 *  receipt: formatting stripped (heading/list/table/emphasis syntax), then
 *  whitespace collapsed. Equal before and after a restyle = the wording
 *  really is unchanged; the receipt only claims what this verifies. */
export function textContentKey(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*]|\d{1,3}[.)])\s+/gm, "")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/\*([^*]*)\*/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\|/g, " ")
    .replace(/^\s*:?-{2,}[\s:|-]*$/gm, "")
    .replace(/[\s.,;:]+/g, " ")
    .trim()
    .toLowerCase();
}
