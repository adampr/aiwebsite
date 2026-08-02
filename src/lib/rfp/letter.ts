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

/** Client-authored labels never start "__": readRfp runs every structure
 *  label and requirement structureLabel through this, so a hostile document
 *  cannot mint a record that lands in a reserved slot. */
export const stripReservedPrefix = (label: string): string =>
  label.replace(/^_+/, "");

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
