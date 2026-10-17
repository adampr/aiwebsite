/**
 * ResolvedProposal — the single input every emitter consumes.
 *
 * RENDERING.md: "ResolvedProposal has every fact already dereferenced and every total already
 * computed. Emitters do no arithmetic, no fact lookup, and no database access. They may not decide
 * anything: if an emitter has a branch that changes WHAT the document says rather than HOW it
 * looks, that branch belongs upstream."
 *
 * This is the type that makes cross-format parity structural rather than a diffing script.
 */

import { blockTextSpans, type Block, type StatTile } from "./blocks";
import type { Finding } from "./audit";
import type { Fact, Reference } from "./knowledge";
import type { DensityMode } from "./page-budget";
import type { PricingQuote } from "./pricing";
import type { CoverStyle, Proposal, Section } from "./proposal";

export type ResolvedSection = {
  id: string;
  /** The client's label, verbatim. Every content page carries it in the eyebrow position. */
  structureLabel: string;
  title: string;
  ordinal: number;
  parentId: string | null;
  blocks: Block[];
};

/** Cover page furniture. Text, not styling: which cover variant is a proposal-level choice. */
export type ResolvedCover = {
  style: CoverStyle;
  clientName: string;
  title: string;
  subtitle: string | null;
  dateLabel: string;
  /** The whole cover lede, present only for a proposal drafted from a brief
   *  (§5.17.17). Absent, emitters print the "Prepared for <client> in
   *  response to the Request for Proposal." form. */
  lede?: string;
};

export type ResolvedSignature = {
  name: string;
  title: string;
  email: string;
  phone: string;
  /** "847.686.0201", rendered as "<phone> ph | fax <fax>". Empty when unknown. */
  fax: string;
  /** LinkedIn profile URL, rendered as a {LinkedIn} link after the name. */
  linkedinUrl: string;
};

/** Cover-letter furniture plus its drafted body (§5.17.4: the letter is
 *  drafted LAST, as a summary of the finished sections). */
export type ResolvedLetter = {
  dateLabel: string;
  /** Addressee block, one line per array entry. */
  addressee: string[];
  salutation: string;
  /** Body paragraphs: the drafted letter, or the short default when none. */
  body: string[];
  /** Postal lines under the addressee (stored client_address, §5.17.20),
   *  printed in the regular face. ABSENT when none are stored, so a letter
   *  without them hashes exactly as before. */
  address?: string[];
  /** The SYSTEM pricing paragraph (quote.ts letterPricingParagraph), printed
   *  after the body and before the closing. Composed from the stored quote
   *  on every resolve, never stored, never Tron-editable: its own span field
   *  keeps a finding on it out of the letter's Fix-it route. ABSENT when
   *  pricing is not ready. */
  pricingParagraph?: string;
  /** The SYSTEM roadmap sentence (furniture.ts letterRoadmapSentence,
   *  §5.17.22), printed directly before the pricing paragraph. Composed on
   *  every resolve from what the document holds, never stored, never
   *  Tron-editable. ABSENT unless a section carries a response matrix. */
  roadmap?: string;
  closing: string;
  signature: ResolvedSignature;
};

export type ResolvedBackCover = {
  headline: string;
  /** The /rfp host puts the cover letter's stored `thesis` here (§5.17.20):
   *  the navy closing sheet prints it as its big line. Null = the fixed
   *  flat-fee line (furniture.ts CLOSING_HEADLINE). */
  subhead: string | null;
  contacts: { label: string; value: string }[];
};

export type ResolvedProposal = {
  proposal: Proposal;
  cover: ResolvedCover;
  letter: ResolvedLetter;
  backCover: ResolvedBackCover;
  sections: ResolvedSection[];
  /** Every total already computed; emitters print, never calculate. */
  pricing: PricingQuote | null;
  /** The references selected for THIS proposal, already resolved. */
  references: Reference[];
  /** Only findings that passed assertFindingPublishable. */
  findings: Finding[];
  /** Every fact cited anywhere in the document, dereferenced by id. */
  facts: Record<string, Fact>;
  density: DensityMode;
  kbVersion: number;
  /** Present only for a proposal drafted from a brief (§5.17.17), so the
   *  furniture that names "the request" can say otherwise. Outside the
   *  content hash, like density. */
  intakeForm?: "brief";
  /** A brief's thematic parts (§5.17.21), resolved ONCE by furniture.ts
   *  documentParts: each part's divider copy, its member labels in sheet
   *  order and each member's part-relative kicker (`kickers[i]` is
   *  `labels[i]`'s). ABSENT on a real RFP, which keeps the legacy two-divider
   *  layout byte-identical. Presentation only: outside the content hash,
   *  like intakeForm and density. */
  parts?: {
    n: 1 | 2 | 3 | 4;
    title: string;
    dek: string | null;
    labels: string[];
    kickers: string[];
    holdsPricing: boolean;
    /** The number the part prints (its place among the rendered parts);
     *  `n` is the canonical part, the parts_json key. */
    position: number;
    /** The Investment sheet's kicker ("Section p.1") in the part that
     *  holds pricing, else null. */
    pricingKicker: string | null;
  }[];
  /** The questionnaire summary (§5.17.22) on its own Overview sheet before
   *  the FIRST response-matrix section's sheet, `label` naming that
   *  section: the verdict tiles (yes / partial / no across every matrix
   *  section, plus an N/A tile when any row is n/a; the total counts every
   *  client item, answered or not, per section), the line naming the items
   *  answered no by their screened subjects, the missing-items honesty
   *  line, and the added-cost index (ref | system rate note). Composed by
   *  resolve-draft from the stored rows through furniture.ts; the subjects
   *  in the no line are screened model text, everything else is system
   *  copy. ABSENT when no section carries a matrix. Presentation of rows
   *  the hash already covers, so outside the content hash. */
  matrixSummary?: {
    label: string;
    tiles: StatTile[];
    noLine: string | null;
    /** Honesty line when client items have no row yet, so the tile counts
     *  visibly need not sum to the total; null when complete. */
    missingLine: string | null;
    costIndex: { ref: string; rateNote: string }[];
  };
  /** The Supporting Documents system sheet (§5.17.23), placed after the
   *  last content sheet and before the closing on every surface: the intro,
   *  the register (one row per requirement of kind "attachment", "You
   *  requested | Where it is", the cell "Attachment N - <title>" or "Not
   *  included"), the numbered list of picks, the confidentiality footnote
   *  (only when a confidential document is picked) and the redacted-sample
   *  note. Composed by resolve-draft through furniture.ts
   *  supportingDocumentsOf; titles are staff-entered, the requested lines
   *  the client's own words, everything else system copy. ABSENT when
   *  nothing is picked, so every earlier document resolves exactly as
   *  before. Outside the content hash, like matrixSummary. */
  supportingDocuments?: {
    intro: string;
    register: { requested: string; whereItIs: string }[];
    list: { n: number; title: string }[];
    confidentialLine: string | null;
    redactedLine: string | null;
  };
  /** Round 35 fix T3 (§5.17.23): per section (sectionId null = the cover
   *  letter) how many attachment citations the resolver stripped because
   *  they named no pick; rule D12 warns on each. ABSENT when none was, so
   *  every other document resolves exactly as before. Outside the content
   *  hash, like supportingDocuments. */
  citationStrips?: { sectionId: string | null; label: string; count: number }[];
  /** Hash of this content model. Two artifacts of the same proposal must share it (rule C2). */
  contentHash: string;
};

/**
 * Every client-facing string in the resolved document, including the furniture.
 *
 * The style and business-term validators scan this rather than the blocks alone, because a
 * "month-to-month" in a back-cover headline is exactly the kind of place the six-instance
 * correction hid the last time.
 */
export function resolvedTextSpans(
  resolved: ResolvedProposal,
): { location: string; field: string; text: string; sectionId?: string; blockId?: string }[] {
  const spans: ReturnType<typeof resolvedTextSpans> = [];

  spans.push(
    { location: "cover", field: "clientName", text: resolved.cover.clientName },
    { location: "cover", field: "title", text: resolved.cover.title },
    { location: "cover", field: "dateLabel", text: resolved.cover.dateLabel },
  );
  if (resolved.cover.subtitle) {
    spans.push({ location: "cover", field: "subtitle", text: resolved.cover.subtitle });
  }
  if (resolved.cover.lede) {
    spans.push({ location: "cover", field: "lede", text: resolved.cover.lede });
  }

  resolved.letter.addressee.forEach((line, i) =>
    spans.push({ location: "letter", field: `addressee[${i}]`, text: line }),
  );
  // The drafted letter body is LLM output rendered client-facing, so it is
  // in the scan surface like any section prose: D1/D2 style scans and B7's
  // currency sweep all cover it.
  resolved.letter.body.forEach((p, i) =>
    spans.push({ location: "letter", field: `body[${i}]`, text: p }),
  );
  // Round-32 furniture (§5.17.20): scanned like the rest of the letter, under
  // field names the letter's Fix-it route does not claim (check-fixes.ts
  // LETTER_SPAN_FIELD), because neither is text Tron can rewrite.
  (resolved.letter.address ?? []).forEach((line, i) =>
    spans.push({ location: "letter", field: `address[${i}]`, text: line }),
  );
  if (resolved.letter.pricingParagraph) {
    spans.push({ location: "letter", field: "pricingParagraph", text: resolved.letter.pricingParagraph });
  }
  // Round 34 (§5.17.22): system text, its own field like pricingParagraph.
  if (resolved.letter.roadmap) {
    spans.push({ location: "letter", field: "roadmap", text: resolved.letter.roadmap });
  }
  spans.push(
    { location: "letter", field: "salutation", text: resolved.letter.salutation },
    { location: "letter", field: "closing", text: resolved.letter.closing },
    { location: "letter", field: "signature.name", text: resolved.letter.signature.name },
    { location: "letter", field: "signature.title", text: resolved.letter.signature.title },
  );

  // Pricing strings the emitters print are client-facing text and scan like
  // any other (D1/D2, B2's hedge scan). The COMPUTED figures inside them are
  // engine output; rule B7's sanctioned set accounts for note figures
  // explicitly, so scanning here does not turn the engine's own numbers into
  // violations.
  if (resolved.pricing) {
    resolved.pricing.illustrations.forEach((ill, i) => {
      spans.push(
        { location: "pricing", field: `illustrations[${i}].label`, text: ill.label },
        { location: "pricing", field: `illustrations[${i}].basis`, text: ill.basis },
      );
    });
    resolved.pricing.passThroughItems.forEach((pt, i) => {
      spans.push(
        { location: "pricing", field: `passThroughItems[${i}].label`, text: pt.label },
        { location: "pricing", field: `passThroughItems[${i}].detail`, text: pt.detail },
      );
    });
    resolved.pricing.notes.forEach((note, i) =>
      spans.push({ location: "pricing", field: `notes[${i}]`, text: note }),
    );
  }

  // A brief's part dividers (§5.17.21): their titles and deks may be
  // model-authored (stored parts_json, sanitized where it landed), and every
  // surface prints them, so they scan like the rest of the furniture.
  (resolved.parts ?? []).forEach((part) => {
    spans.push({ location: "parts", field: `part[${part.n}].title`, text: part.title });
    if (part.dek) spans.push({ location: "parts", field: `part[${part.n}].dek`, text: part.dek });
  });

  // The questionnaire summary (§5.17.22): system furniture on the first
  // matrix section's sheet, under its own location (no sectionId, no
  // blockId) so no section Fix-it route claims a finding on it. The cost
  // index's rate notes are the rows' own system text (rule B7 sanctions
  // `costIndex[i].rateNote` exactly as it does a row's `rows[i].rateNote`).
  if (resolved.matrixSummary) {
    const ms = resolved.matrixSummary;
    ms.tiles.forEach((t, i) => {
      spans.push({ location: "matrix-summary", field: `tiles[${i}].value`, text: t.value });
      spans.push({ location: "matrix-summary", field: `tiles[${i}].label`, text: t.label });
    });
    if (ms.noLine) spans.push({ location: "matrix-summary", field: "noLine", text: ms.noLine });
    if (ms.missingLine) spans.push({ location: "matrix-summary", field: "missingLine", text: ms.missingLine });
    ms.costIndex.forEach((c, i) => {
      spans.push({ location: "matrix-summary", field: `costIndex[${i}].ref`, text: c.ref });
      spans.push({ location: "matrix-summary", field: `costIndex[${i}].rateNote`, text: c.rateNote });
    });
  }

  // The Supporting Documents sheet (§5.17.23): system furniture under its
  // own location (no sectionId, no blockId), so no section Fix-it route
  // claims a finding on it, scanned like the summary sheet.
  if (resolved.supportingDocuments) {
    const sd = resolved.supportingDocuments;
    spans.push({ location: "supporting-documents", field: "intro", text: sd.intro });
    sd.register.forEach((r, i) => {
      spans.push({ location: "supporting-documents", field: `register[${i}].requested`, text: r.requested });
      spans.push({ location: "supporting-documents", field: `register[${i}].whereItIs`, text: r.whereItIs });
    });
    sd.list.forEach((p, i) =>
      spans.push({ location: "supporting-documents", field: `list[${i}].title`, text: p.title }),
    );
    if (sd.confidentialLine)
      spans.push({ location: "supporting-documents", field: "confidentialLine", text: sd.confidentialLine });
    if (sd.redactedLine)
      spans.push({ location: "supporting-documents", field: "redactedLine", text: sd.redactedLine });
  }

  spans.push({ location: "back-cover", field: "headline", text: resolved.backCover.headline });
  if (resolved.backCover.subhead) {
    spans.push({ location: "back-cover", field: "subhead", text: resolved.backCover.subhead });
  }
  resolved.backCover.contacts.forEach((c, i) => {
    spans.push({ location: "back-cover", field: `contacts[${i}].label`, text: c.label });
    spans.push({ location: "back-cover", field: `contacts[${i}].value`, text: c.value });
  });

  for (const section of resolved.sections) {
    spans.push({
      location: `section:${section.structureLabel}`,
      field: "structureLabel",
      text: section.structureLabel,
      sectionId: section.id,
    });
    spans.push({
      location: `section:${section.structureLabel}`,
      field: "title",
      text: section.title,
      sectionId: section.id,
    });
    for (const block of section.blocks) {
      for (const span of blockTextSpans(block)) {
        spans.push({
          location: `section:${section.structureLabel}`,
          field: span.field,
          text: span.text,
          sectionId: section.id,
          blockId: block.id,
        });
      }
    }
  }

  return spans;
}

/** The whole document as plain text. Used by the cross-format parity backstop. */
export function resolvedPlainText(resolved: ResolvedProposal): string {
  return resolvedTextSpans(resolved)
    .map((s) => s.text)
    .join("\n");
}

export function findSection(resolved: ResolvedProposal, sectionId: string): ResolvedSection | undefined {
  return resolved.sections.find((s) => s.id === sectionId);
}

export function findBlock(resolved: ResolvedProposal, blockId: string): Block | undefined {
  for (const section of resolved.sections) {
    const block = section.blocks.find((b) => b.id === blockId);
    if (block) return block;
  }
  return undefined;
}

/** Convert stored sections to resolved ones, preserving order. */
export function toResolvedSections(sections: Section[]): ResolvedSection[] {
  return [...sections]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((s) => ({
      id: s.id,
      structureLabel: s.structureLabel,
      title: s.title,
      ordinal: s.ordinal,
      parentId: s.parentId,
      blocks: [...s.blocks].sort((a, b) => a.ordinal - b.ordinal),
    }));
}
