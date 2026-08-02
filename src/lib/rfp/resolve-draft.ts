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
import { DEFAULT_LETTER_BODY, splitSections } from "./letter";
import { signatureFor } from "./signature";
import type { DraftSectionRecord } from "@/app/api/rfp/documents/[id]/generate/route";

const blockId = (label: string, i: number) =>
  `b_${label.replace(/[^a-zA-Z0-9]+/g, "_")}_${i}`;

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
  const ordered: DraftSectionRecord[] = [];
  for (const node of input.structure) {
    const sec = drafted.find((s) => s.label === node.label);
    if (sec) ordered.push(sec);
  }
  for (const sec of drafted)
    if (!ordered.includes(sec)) ordered.push(sec);

  const sections: Section[] = ordered.map((sec, ordinal) => {
    const sectionId = `sec_${sec.label.replace(/[^a-zA-Z0-9]+/g, "_")}`;
    const blocks: Block[] = sec.paragraphs.map((text, i) => ({
      kind: "prose",
      id: blockId(sec.label, i),
      sectionId,
      ordinal: i,
      cites: sec.cites,
      generatedBy: sec.generatedBy,
      editedByHuman: sec.generatedBy === "human",
      text,
    }));
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
  const dateLabel = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

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
      clientName: doc.clientName?.trim() || proposal.title,
      title: "Response to Request for Proposal",
      subtitle: doc.clientName ? proposal.title : null,
      dateLabel,
    },
    letter: {
      dateLabel,
      addressee: [clientName],
      // The addressee line above already names the client; restating it
      // read "Dear The Children's..." (same fix as the workspace page).
      salutation: "Dear evaluation team,",
      body: letterRecord?.paragraphs.length
        ? letterRecord.paragraphs
        : DEFAULT_LETTER_BODY,
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
      subhead: null,
      contacts: [{ label: "Email", value: proposal.ownerEmail }],
    },
    sections: toResolvedSections(sections),
    pricing: input.quote,
    references: [],
    findings: [],
  };

  const factsById: Record<string, Fact> = {};
  for (const row of input.allFacts) factsById[row.id] = factFromRow(row);
  for (const row of input.myKnowledge)
    factsById[`pending_${row.id}`] = pendingFact(row);

  const resolved: ResolvedProposal = {
    ...core,
    facts: Object.fromEntries(
      Object.entries(factsById).filter(([id]) =>
        sections.some((s) => s.blocks.some((b) => b.cites.includes(id)))
      )
    ),
    density: "default",
    kbVersion: input.kbVersion,
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
