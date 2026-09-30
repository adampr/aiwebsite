// What the references answer does to the stored sections (ARCHITECTURE.md §5.17.10).
//
// The record-building of POST /api/rfp/proposals/[id]/references, the carry a
// redraft performs on a section that holds a references block, and what
// removing that block puts back, as PURE functions: no database, no clock the
// caller did not hand in. The routes call these and nothing else decides the
// shape, so the gate tests exercise the SAME composition production runs
// (scripts/rfp-visual-gate-tests.ts, scripts/rfp-references-tests.ts) and the
// fixture's References section is built by it.
//
// SERVER-SIDE ONLY: it imports references-ask.ts (lookbehind regexes). A
// client component never imports this module.

import type { DraftSectionRecord } from "@/app/api/rfp/documents/[id]/generate/route";
import { LIMITS, buildReferencesBlock, type DraftBlock } from "./draft-blocks";
import { keptBlocks, withBlocks } from "./draft-blocks-ops";
import { collectOpenQuestions } from "./gaps";
import {
  asksAboutReferences,
  composeReferencesParagraphs,
  withReferencesGap,
  type ReferencesAsk,
} from "./references-ask";
import type { ReferenceEntry } from "./references-block";

type Rec = DraftSectionRecord;

/**
 * Everything rule D3 scans besides the target section's own paragraphs: the
 * proposal title, every other record's label, title and paragraphs (the
 * letter included), and the target's label and title. The gap route builds
 * the same text. `own` overrides the target's label and title (a redraft
 * lands the structure's current title, which may differ from the stored one).
 */
export function referencesOtherText(
  proposalTitle: string,
  sections: Pick<Rec, "label" | "title" | "paragraphs">[],
  at: number,
  own?: { label: string; title: string }
): string {
  const lines = [
    proposalTitle,
    ...sections.map((s, i) =>
      i === at
        ? `${(own ?? s).label}\n${(own ?? s).title}`
        : `${s.label}\n${s.title}\n${s.paragraphs.join("\n")}`
    ),
  ];
  if (at < 0 && own) lines.push(`${own.label}\n${own.title}`);
  return lines.join("\n");
}

/** A record without any question about client references (the canonical one
 *  at any count, or a model-worded one). The same object when it held none. */
export function closeReferencesQuestions<S extends Pick<Rec, "gaps">>(section: S): S {
  if (!section.gaps.some((g) => asksAboutReferences(g.question))) return section;
  return {
    ...section,
    gaps: section.gaps.filter((g) => !asksAboutReferences(g.question)),
  };
}

/**
 * The target section after the person's references land on it.
 *
 * - Paragraphs go through THE composer (references-ask.ts), so the intro and
 *   rule D3's etiquette sentence are there exactly once and never as a 13th
 *   paragraph.
 * - First answer: every stored block stays except a previous `references`
 *   one, and the new block closes the section (last in the array, anchored
 *   after the last paragraph). When the section is at the per-section cap the
 *   last other block gives way (`trimmed`).
 * - `replace` (an edit of an answer already given): the card set takes the old
 *   block's slot in the array and keeps its anchor. When there is no block to
 *   replace the entries land as a first answer would.
 * - Every references question on the record closes.
 * - cites and generatedBy carry over, with ONE exception: a section whose
 *   paragraphs were EMPTY before the answer becomes "human". Its only prose
 *   is then the system-written intro, which no fact backs; left as "llm" with
 *   no cites it would BLOCK on rule A5 for a sentence no model wrote. Nothing
 *   is laundered: there was no model prose on the record to relabel, and a
 *   visual block carries its own generatedBy and cites.
 */
export function applyReferencesAnswer<S extends Rec>(
  section: S,
  otherText: string,
  entries: ReferenceEntry[],
  opts: { replace?: boolean; now?: string } = {}
): { section: S; trimmed: boolean } {
  const wasEmpty = section.paragraphs.length === 0;
  const paragraphs = composeReferencesParagraphs(section.paragraphs, otherText);
  const stored = keptBlocks(section, paragraphs.length) ?? [];
  const oldAt = stored.findIndex((b) => b.origin === "references");
  const others = stored.filter((b) => b.origin !== "references");
  let blocks: DraftBlock[];
  let trimmed = false;
  if (opts.replace && oldAt >= 0) {
    const old = stored[oldAt];
    // A block that closed the section keeps closing it when the composer had
    // to put the intro back as a new last paragraph.
    const after =
      old.after >= section.paragraphs.length ? paragraphs.length : old.after;
    const slot = stored.slice(0, oldAt).filter((b) => b.origin !== "references").length;
    blocks = [
      ...others.slice(0, slot),
      buildReferencesBlock(entries, after),
      ...others.slice(slot),
    ];
  } else {
    if (others.length >= LIMITS.blocksPerSection) {
      others.length = LIMITS.blocksPerSection - 1;
      trimmed = true;
    }
    blocks = [...others, buildReferencesBlock(entries, paragraphs.length)];
  }
  const updated = withBlocks(
    {
      ...closeReferencesQuestions(section),
      paragraphs,
      cites: section.cites,
      generatedBy: wasEmpty ? ("human" as const) : section.generatedBy,
      // The generate route's backstop reads this stamp as "answered".
      referencesAnswered: true,
      updatedAt: opts.now ?? new Date().toISOString(),
    },
    blocks
  ) as unknown as S;
  return { section: updated, trimmed };
}

/**
 * What a REDRAFT lands when the previous record carried a references block:
 * the fresh paragraphs through the composer (a redraft writes new prose, so
 * the intro and the etiquette sentence are put back), the drafter's and the
 * system's blocks cut to the cap minus one, and the carried block LAST,
 * anchored after the last paragraph, so it closes the section and rule D3
 * cannot BLOCK after a redraft. `human` is true when the fresh draft came
 * back with no paragraphs at all: the record's only prose is then the
 * system-written intro (the A5 rule of applyReferencesAnswer).
 */
export function carryReferencesBlock(input: {
  paragraphs: string[];
  blocks: DraftBlock[] | undefined;
  carried: DraftBlock;
  otherText: string;
}): { paragraphs: string[]; blocks: DraftBlock[]; human: boolean } {
  const paragraphs = composeReferencesParagraphs(input.paragraphs, input.otherText);
  const others = (input.blocks ?? [])
    .filter((b) => b.origin !== "references")
    .slice(0, LIMITS.blocksPerSection - 1);
  return {
    paragraphs,
    blocks: [...others, { ...input.carried, after: paragraphs.length }],
    human: input.paragraphs.length === 0,
  };
}

/**
 * After the references block was removed from `sections[at]`: put the
 * question back on that section when its requirements still ask for
 * references (`ask`, from referencesAsk) and nothing else answers it. Not
 * reopened when the section already holds a references question, when another
 * section carries the person's answer (`referencesAnswered`), or when the
 * text presents references. A references question open elsewhere on the
 * proposal is reused byte for byte, as at landing. The same array comes back
 * when nothing is added.
 */
export function reopenReferencesQuestion<S extends Rec>(
  sections: S[],
  at: number,
  ask: ReferencesAsk | null,
  why: string
): S[] {
  const section = sections[at];
  if (!section || !ask) return sections;
  if (section.gaps.some((g) => asksAboutReferences(g.question))) return sections;
  const others = sections.filter(
    (s, i) => i !== at && !s.label.startsWith("__")
  );
  if (others.some((s) => s.referencesAnswered === true)) return sections;
  const landed = withReferencesGap([], {
    ask,
    paragraphs: section.paragraphs,
    otherSections: others.map((s) => s.paragraphs),
    openQuestions: collectOpenQuestions(sections, section.label),
    why,
  });
  if (landed.length === 0) return sections;
  const question = landed[landed.length - 1];
  return sections.map((s, i) =>
    i === at ? { ...s, gaps: [...s.gaps, question] } : s
  );
}
