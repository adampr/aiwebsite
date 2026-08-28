// The cover letter as a draftable record (ARCHITECTURE.md §5.17.4).
//
// The letter lives in the same sectionsJson array as the drafted sections,
// under a RESERVED label. That buys it the whole section machinery for free:
// the generation claim, the rev CAS, the status poll, human edit (PATCH) and
// Tron revision (POST) on the section route, all keyed by label. Everything
// that iterates REAL sections must exclude it, which is what splitSections
// is for; resolve-draft routes its paragraphs into the letter furniture so
// the style rules scan it and both emitters render it, and it never appears
// as a trailing pseudo-section.
//
// The label is unforgeable from outside: readRfp strips leading underscores
// from client structure labels, and the generate route rejects any other
// "__"-prefixed label, so a hostile RFP cannot smuggle a section that lands
// in the letter slot.

import type { DraftSectionRecord } from "@/app/api/rfp/documents/[id]/generate/route";

export const LETTER_LABEL = "__letter";
export const LETTER_TITLE = "Cover Letter";

/** Whole-document scope sentinel for the Tron pane (§5.17.1): the section
 *  route treats this label as "plan a revision across every section" rather
 *  than a section lookup. Same unforgeability story as LETTER_LABEL: it
 *  shares the reserved "__" namespace, and readRfp strips leading
 *  underscores from client labels, so a hostile RFP cannot mint a section
 *  whose label triggers the plan branch. */
export const DOC_LABEL = "__doc";

/** Client-authored labels never start "__": readRfp runs every structure
 *  label and requirement structureLabel through this, so a hostile document
 *  cannot mint a record that lands in a reserved slot. */
export const stripReservedPrefix = (label: string): string =>
  label.replace(/^_+/, "");

/**
 * Whether a section label renders VERBATIM as the visible header eyebrow.
 * This is the workspace's secKicker branch test (and export-assets'
 * sectionKicker replica), verbatim: bare numbering ("4.2", "F", "III")
 * renders as "Section 4.2", so its heading lives in the TITLE; a worded
 * label ("June 8th, 2026:", "Current IT Provider Issues") IS the heading
 * people see. The section PATCH's retitle op keys on this to decide which
 * slot a replacement header lands in — keep all three in lockstep.
 */
export const labelDisplaysWorded = (label: string): boolean => {
  const t = label.trim();
  if (!t) return false;
  if (/^M{0,4}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/i.test(t))
    return false;
  return /[a-z]{3,}/i.test(t);
};

/** What the letter page says before the letter is drafted. Also the export
 *  body for a proposal whose letter was never drafted: short, claim-free,
 *  exactly the furniture text this page always carried. */
export const DEFAULT_LETTER_BODY = [
  "Thank you for the opportunity to respond to your Request for Proposal. The pages that follow address your document in its own structure, section by section, together with our pricing.",
  "We welcome the opportunity to discuss this proposal with you.",
];

export function splitSections(all: DraftSectionRecord[]): {
  letter: DraftSectionRecord | null;
  sections: DraftSectionRecord[];
} {
  return {
    letter: all.find((s) => s.label === LETTER_LABEL) ?? null,
    sections: all.filter((s) => s.label !== LETTER_LABEL),
  };
}
