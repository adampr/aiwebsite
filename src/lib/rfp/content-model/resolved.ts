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

import { blockTextSpans, type Block } from "./blocks";
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
};

export type ResolvedSignature = {
  name: string;
  title: string;
  email: string;
  phone: string;
};

/** Cover-letter furniture. The letter's body paragraphs are blocks in the first section. */
export type ResolvedLetter = {
  dateLabel: string;
  /** Addressee block, one line per array entry. */
  addressee: string[];
  salutation: string;
  closing: string;
  signature: ResolvedSignature;
};

export type ResolvedBackCover = {
  headline: string;
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

  resolved.letter.addressee.forEach((line, i) =>
    spans.push({ location: "letter", field: `addressee[${i}]`, text: line }),
  );
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
