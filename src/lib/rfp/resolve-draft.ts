// Draft-to-content-model adapter (ARCHITECTURE.md §5.17.1).
//
// The workspace stores DraftSectionRecord[] (label, title, paragraphs, cites,
// gaps) — deliberately simpler than the ported IR, because re-parsing prose
// into the closed 15-variant block set cannot round-trip. This adapter lifts
// that runtime shape into a ResolvedProposal so the 26 ported compliance
// rules and both emitters consume the REAL model, not a lookalike:
//
//   - each paragraph becomes one ProseBlock carrying the section's cites and
//     generatedBy, which is exactly what rules A5 and C1 join on
//   - each stored visual block (draft-blocks.ts) is lifted into the content
//     model's own variant of the same kind, with ITS cites and generatedBy,
//     at its place in the one shared ordering (`interleave`)
//   - the computed PricingQuote is attached verbatim (rules B1-B7)
//   - contentHash uses rule C2's own field set, so C2 verifies the adapter
//     rather than being skipped
//
// Furniture (cover, letter, back cover) is synthesized from the document row
// and the owner. It states only what is known: names, dates, emails. It
// never invents a capability, and it IS scanned by the style rules.

import type { DocumentRow, FactRow, ProposalRow, RequirementRow } from "./db";
import type { KnowledgeProposalRow } from "./db";
import {
  contentHash,
  toResolvedSections,
  type Block,
  type Fact,
  type KnowledgeSnapshot,
  type PricingQuote,
  type RateCard,
  type Requirement,
  type RequirementCoverage,
  type ResolvedProposal,
  type Section,
} from "./content-model";
import { runGate, type GateResult } from "./validators/gate";
import { defaultLetterBody, splitSections } from "./letter";
import { signatureFor } from "./signature";
import {
  coverLede,
  coverTitle,
  documentParts,
  letterAddresseeLines,
  letterThesis,
  orderDrafted,
  recipientAddressLines,
} from "./furniture";
import { letterPricingParagraph, partPricingDek } from "./quote";
import { interleave, sanitizeStoredBlocks, type DraftBlock } from "./draft-blocks";
import { referenceCardTable, type ReferenceEntry } from "./references-block";
import type { Reference } from "./content-model/knowledge";
import type { DraftSectionRecord } from "@/app/api/rfp/documents/[id]/generate/route";

const blockId = (label: string, i: number) =>
  `b_${label.replace(/[^a-zA-Z0-9]+/g, "_")}_${i}`;

/** A visual's id carries its own stored id, never a position: a paragraph
 *  edit above it must not move the locator a gate violation points at. */
const visualBlockId = (label: string, id: string) =>
  `bv_${label.replace(/[^a-zA-Z0-9]+/g, "_")}_${id}`;

/** The body of a DraftBlock IS the content-model body (draft-blocks.ts), so
 *  lifting is dropping the storage envelope and adding the BlockBase fields.
 *
 *  The exception is `references`, which has no content-model kind of its
 *  own: it lifts into ONE `table` per entry (references-block.ts is the one
 *  card spec), ids `<visual id>_1.._N`, consecutive ordinals from `ordinal`.
 *  Those tables are generatedBy "human" with no cites: the person supplied
 *  the contacts, and rule A5 demands cites of "llm" blocks only. */
function liftVisual(
  block: DraftBlock,
  label: string,
  sectionId: string,
  ordinal: number
): Block[] {
  const { id, after: _after, origin: _origin, ...body } = block;
  if (body.kind === "references")
    return body.references.map((entry, i) => ({
      ...referenceCardTable(entry, i + 1),
      id: `${visualBlockId(label, id)}_${i + 1}`,
      sectionId,
      ordinal: ordinal + i,
      cites: [],
      generatedBy: "human",
      editedByHuman: true,
    }));
  return [
    {
      ...body,
      id: visualBlockId(label, id),
      sectionId,
      ordinal,
      editedByHuman: false,
    },
  ];
}

/** A lifted entry as `proposal.references` carries it, so rule D3 sees the
 *  references whatever the prose says. A typed-in organization (no
 *  rfp_references row) gets a positional id; `segment` is the card's
 *  relevance column, with the card's own fallback wording. */
function referenceFromEntry(entry: ReferenceEntry, n: number): Reference {
  return {
    id: entry.referenceId ?? `ref_typed_${n}`,
    organization: entry.organization,
    website: null,
    segment: entry.relevance || "comparable client",
    contactName: entry.contactName,
    contactTitle: entry.contactTitle,
    contactPhone: entry.phone || null,
    contactEmail: entry.email || null,
    relationshipSince: null,
    usableWithoutAsking: false,
    notes: null,
    retiredAt: null,
    replacedBy: null,
  };
}

function factFromRow(row: FactRow): Fact {
  return {
    id: row.id,
    key: row.key,
    category: row.category as Fact["category"],
    statement: row.statement,
    polarity: row.polarity as Fact["polarity"],
    detail: row.detail,
    sourceUrl: row.sourceUrl,
    verifiedAt: row.verifiedAt,
    correctedAt: row.correctedAt,
    supersedes: row.supersedes,
    introducedInKb: row.introducedInKb,
    retiredInKb: row.retiredInKb,
    confidence: row.confidence as Fact["confidence"],
  };
}

/** The user's private knowledge, in the pseudo-id form drafting cites it as. */
function pendingFact(row: KnowledgeProposalRow): Fact {
  return {
    id: `pending_${row.id}`,
    key: row.factKey ?? "pending",
    category: "capability",
    statement: row.statement,
    polarity: row.polarity as Fact["polarity"],
    detail: row.detail,
    sourceUrl: null,
    verifiedAt: null,
    correctedAt: null,
    supersedes: null,
    introducedInKb: 0,
    retiredInKb: null,
    confidence: "needs-adam",
  };
}

const KIND_MAP: Record<string, Requirement["kind"]> = {
  question: "factual",
  statement: "narrative",
  attachment: "attachment",
};

export type DraftGateInput = {
  doc: DocumentRow;
  proposal: ProposalRow;
  sections: DraftSectionRecord[];
  structure: { label: string; title: string }[];
  requirements: RequirementRow[];
  quote: PricingQuote | null;
  /** ALL fact rows, retired included — C1 must resolve superseded citations. */
  allFacts: FactRow[];
  /** The owner's private knowledge rows, for `pending_*` citations. */
  myKnowledge: KnowledgeProposalRow[];
  rateCard: RateCard;
  kbVersion: number;
  ownerName: string;
  statesHeadcountOnly: boolean;
  supportedUserSplitConfirmed: boolean;
};

export function resolveDraft(input: DraftGateInput): {
  resolved: ResolvedProposal;
  requirements: Requirement[];
  coverage: RequirementCoverage[];
  factsById: Record<string, Fact>;
  knowledge: KnowledgeSnapshot;
} {
  const { doc, proposal } = input;

  // The letter record shares sectionsJson under its reserved label; it is
  // routed into the letter furniture below, never into the section list,
  // where it would render as a trailing pseudo-section.
  const { letter: letterRecord, sections: drafted } = splitSections(
    input.sections
  );

  // Sections in the CLIENT's order (rule C4). A drafted section whose label
  // is no longer in the structure still renders, after the structured ones.
  // furniture.ts orderDrafted is that rule, shared with the part resolution
  // below and the workspace, so all of them count the same sheets.
  const ordered = orderDrafted(input.structure, drafted);

  const references: Reference[] = [];
  const sections: Section[] = ordered.map((sec, ordinal) => {
    const sectionId = `sec_${sec.label.replace(/[^a-zA-Z0-9]+/g, "_")}`;
    // The ONE ordering the screen and both emitters share. Prose keeps the
    // id of its PARAGRAPH index (so a locator on a prose-only section is
    // what it always was) and every block's ordinal is its place in the
    // flow; with no visuals the two are the same number. A references
    // block is the one flow item that lifts into several blocks, so the
    // ordinal is counted, not taken from the flow index: everything after
    // it in the same section shifts by N-1, nothing before it moves.
    const flow = interleave(
      sec.paragraphs,
      sanitizeStoredBlocks(sec.blocks, sec.paragraphs.length)
    );
    let next = 0;
    const blocks: Block[] = flow.flatMap((item): Block[] => {
      if (item.type === "p")
        return [
          {
            kind: "prose",
            id: blockId(sec.label, item.index),
            sectionId,
            ordinal: next++,
            cites: sec.cites,
            generatedBy: sec.generatedBy,
            editedByHuman: sec.generatedBy === "human",
            text: item.text,
          },
        ];
      const lifted = liftVisual(item.block, sec.label, sectionId, next);
      next += lifted.length;
      // Numbered across the whole document, so two typed-in entries on two
      // sections never share a positional id.
      if (item.block.kind === "references")
        for (const entry of item.block.references)
          references.push(referenceFromEntry(entry, references.length + 1));
      return lifted;
    });
    return {
      id: sectionId,
      proposalId: proposal.id,
      structureLabel: sec.label,
      title: sec.title,
      ordinal,
      parentId: null,
      blocks,
      reviewState: sec.generatedBy === "human" ? "edited" : "generated",
    };
  });

  const clientName = doc.clientName?.trim() || "the client";
  // A brief answers no Request for Proposal (§5.17.17): its cover and its
  // undrafted letter say so. Form "rfp" is byte-identical.
  const fromBrief = doc.intakeForm === "brief";
  // The grounded addressee (§5.17.17), when the read found one: it heads the
  // address block and is the one the letter greets.
  const contactName = doc.contactName?.trim() || null;
  const contactTitle = doc.contactTitle?.trim() || null;
  const dateLabel = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  // Who the cover names: the client, else the proposal title (the
  // workspace's coverClientName fallback, so screen and file agree).
  const coverWho = doc.clientName?.trim() || proposal.title;
  // Round-32 furniture (§5.17.20), every piece from a STORED field and each
  // ABSENT when its field is, so a document without them resolves (and
  // hashes) exactly as before.
  const coverLedeText = coverLede({
    intakeForm: doc.intakeForm,
    who: coverWho.trim() || null,
    contactName,
    contactTitle,
  });
  const address = recipientAddressLines(doc.clientAddress, [
    contactName,
    contactTitle,
    doc.clientName,
  ]);
  const pricingParagraph = letterPricingParagraph(
    input.quote,
    input.rateCard.minimumFullyManagedUsers
  );
  const thesis = letterThesis(letterRecord?.thesis);

  const core = {
    proposal: {
      id: proposal.id,
      rfpId: doc.id,
      clientId: doc.clientName ?? "",
      title: proposal.title,
      status: proposal.status as ResolvedProposal["proposal"]["status"],
      draftedAt: proposal.createdAt,
      draftedAgainstKbVersion: proposal.draftedAgainstKbVersion,
      approvedBy: proposal.approvedBy,
      approvedAt: proposal.approvedAt,
      coverStyle: "arc-mark" as const,
      createdBy: proposal.ownerEmail,
      supersedes: null,
    },
    cover: {
      style: "arc-mark" as const,
      clientName: coverWho,
      // Client, else the proposal title: the workspace's coverClientName
      // fallback, so screen and file print the same title. A brief prints
      // its stored narrative headline when the read produced one.
      title: coverTitle({
        intakeForm: doc.intakeForm,
        who: coverWho.trim() || null,
        proposalHeadline: fromBrief ? doc.proposalHeadline : null,
      }),
      subtitle: doc.clientName ? proposal.title : null,
      dateLabel,
      ...(coverLedeText !== undefined ? { lede: coverLedeText } : {}),
    },
    letter: {
      dateLabel,
      // A contact with no client name stands alone: no "the client" line.
      // Round 32 (§5.17.20): the name, then the title on its own line, then
      // the client; every surface sets line 0 bold and the rest regular.
      addressee: letterAddresseeLines({
        contactName,
        contactTitle,
        clientName: doc.clientName,
      }),
      // The addressee line above already names the client; restating it
      // read "Dear The Children's..." (same fix as the workspace page).
      salutation: contactName ? `Dear ${contactName},` : "Dear evaluation team,",
      body: letterRecord?.paragraphs.length
        ? letterRecord.paragraphs
        : defaultLetterBody(doc.intakeForm),
      ...(address.length ? { address } : {}),
      ...(pricingParagraph ? { pricingParagraph } : {}),
      // "Regards," is the closing of the standard XL.net signature block
      // (owner's email signature, 2026-08-02); the signature module carries
      // the per-person lines under it.
      closing: "Regards,",
      signature: (() => {
        const sig = signatureFor(proposal.ownerEmail, input.ownerName);
        return {
          name: sig.name,
          // Empty when the signer has no directory entry: the company half
          // of the signature block names XL.net already, so a placeholder
          // title would just duplicate it.
          title: sig.title ?? "",
          email: sig.email,
          phone: sig.phone ?? "",
          fax: sig.fax ?? "",
          linkedinUrl: sig.linkedinUrl ?? "",
        };
      })(),
    },
    backCover: {
      headline: "XL.net",
      // The letter's one-line argument, printed as the closing sheet's big
      // line (§5.17.20); null keeps the fixed flat-fee line.
      subhead: thesis,
      contacts: [{ label: "Email", value: proposal.ownerEmail }],
    },
    sections: toResolvedSections(sections),
    pricing: input.quote,
    // The lifted references blocks' entries, in document order, so rule D3
    // (and C2's hash, which covers this field) see what the cards show.
    references,
    findings: [],
  };

  const factsById: Record<string, Fact> = {};
  for (const row of input.allFacts) factsById[row.id] = factFromRow(row);
  for (const row of input.myKnowledge)
    factsById[`pending_${row.id}`] = pendingFact(row);

  // A brief's thematic parts (§5.17.21): ONE resolution (furniture.ts
  // documentParts over outline.ts resolveParts) that the gate, both emitters
  // (through buildExportView) and the workspace all read. Null on a real
  // RFP, which then resolves exactly as before (no `parts` key at all).
  const docParts = documentParts({
    intakeForm: doc.intakeForm,
    structure: input.structure,
    drafted,
    partsJson: proposal.partsJson,
    pricingPresent: input.quote !== null,
    // The pricing part's dek is system-composed from the same quote and
    // minimum the letter's pricing paragraph reads (quote.ts).
    pricingDek: partPricingDek(input.quote, input.rateCard.minimumFullyManagedUsers),
  });

  const resolved: ResolvedProposal = {
    ...core,
    facts: Object.fromEntries(
      Object.entries(factsById).filter(([id]) =>
        sections.some((s) => s.blocks.some((b) => b.cites.includes(id)))
      )
    ),
    density: "default",
    kbVersion: input.kbVersion,
    ...(fromBrief ? { intakeForm: "brief" as const } : {}),
    ...(docParts
      ? {
          parts: docParts.parts.map((p) => ({
            n: p.n,
            title: p.title,
            dek: p.dek,
            labels: [...p.labels],
            kickers: p.labels.map((l) => docParts.kicker(l)),
            holdsPricing: p.holdsPricing,
            position: p.position,
            pricingKicker: p.pricingKicker,
          })),
        }
      : {}),
    // Rule C2's own field set, so C2 re-derives and verifies it.
    contentHash: contentHash(core),
  };

  const requirements: Requirement[] = input.requirements.map((r) => ({
    id: r.id,
    rfpId: doc.id,
    structureLabel: r.structureLabel,
    text: r.text,
    ordinal: r.ordinal,
    kind: KIND_MAP[r.kind] ?? "factual",
    mandatory: r.mandatory,
  }));

  // Coverage is derived, not stored: a requirement counts covered when its
  // structure node has a drafted section with content. Finer states
  // (gap-acknowledged, partial) need block-level mapping the runtime shape
  // does not carry; open gaps are enforced separately at export.
  const bySectionLabel = new Map(sections.map((s) => [s.structureLabel, s]));
  const coverage: RequirementCoverage[] = [];
  for (const req of requirements) {
    const sec = bySectionLabel.get(req.structureLabel);
    if (sec && sec.blocks.length > 0)
      coverage.push({
        requirementId: req.id,
        sectionId: sec.id,
        state: "covered",
        note: null,
      });
  }

  const knowledge: KnowledgeSnapshot = {
    kbVersion: input.kbVersion,
    facts: input.allFacts.map(factFromRow),
    references: [],
    rateCard: input.rateCard,
    questions: [],
  };

  return { resolved, requirements, coverage, factsById, knowledge };
}

/** Run the full compliance gate against a runtime draft. */
export function runDraftGate(input: DraftGateInput): GateResult {
  const { resolved, requirements, coverage, factsById, knowledge } =
    resolveDraft(input);
  return runGate({
    proposal: resolved,
    knowledge,
    rateCard: input.rateCard,
    requirements,
    coverage,
    factsById,
    statesHeadcountOnly: input.statesHeadcountOnly,
    supportedUserSplitConfirmed: input.supportedUserSplitConfirmed,
  });
}
