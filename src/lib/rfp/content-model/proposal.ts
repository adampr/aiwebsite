/**
 * Proposal, Section, and the join tables that make the staleness sweep a query.
 */

import type { Block } from "./blocks";

export type ProposalStatus = "draft" | "in-review" | "approved" | "sent" | "superseded";

export type CoverStyle = "arc-mark" | "solid-blue" | "split-panel";

export type Proposal = {
  id: string;
  rfpId: string;
  clientId: string;
  title: string;
  status: ProposalStatus;
  draftedAt: Date;
  /**
   * KbVersion.seq. The cheap staleness check: if the current KB seq is greater, SOMETHING changed
   * and this proposal may be affected. The expensive check is the correctedAt query, which says
   * whether the change actually touches this proposal. Cheap one on page load, expensive one in
   * the gate.
   */
  draftedAgainstKbVersion: number;
  approvedBy: string | null;
  approvedAt: Date | null;
  coverStyle: CoverStyle;
  createdBy: string;
  /**
   * A proposal is never edited after `sent`. Corrections create a NEW proposal with supersedes
   * pointing back, because rule C1 says rebuild rather than patch, and the model should make
   * patching awkward rather than merely discouraged.
   */
  supersedes: string | null;
};

export type Section = {
  id: string;
  proposalId: string;
  /** The client's label, verbatim. Rule C4 forbids normalizing it. */
  structureLabel: string;
  /** The client's heading, verbatim. */
  title: string;
  ordinal: number;
  parentId: string | null;
  blocks: Block[];
  reviewState: "generated" | "edited" | "approved";
};

/**
 * A join table rather than an array column, because the C1 query joins on it and because a fact
 * needs to find its dependents cheaply in both directions.
 */
export type BlockFactCitation = {
  blockId: string;
  factId: string;
  /** Optional: the substring of the block this fact supports. */
  span: string | null;
};

export type CoverageState = "covered" | "partial" | "gap-acknowledged" | "uncovered";

export type RequirementCoverage = {
  requirementId: string;
  sectionId: string;
  /**
   * "gap-acknowledged" is distinct from "uncovered" and it matters: rule D4 says an honest "we do
   * not do this, here is what we do instead" is a correct answer, not a hole. The gate blocks on
   * uncovered and passes gap-acknowledged.
   */
  state: CoverageState;
  note: string | null;
};

/**
 * Per-proposal decisions, kept in their own table so they can never leak into the knowledge base.
 * Pricing presentation, which references to use, how to frame an unmet scope requirement: all
 * choices, all reasonably different for the next client.
 */
export type Choice = {
  id: string;
  proposalId: string;
  questionId: string | null;
  /** "references.selected", "pricing.illustration-basis" */
  key: string;
  value: string;
  decidedBy: string;
  decidedAt: Date;
};

export type IntakeAnswer = {
  id: string;
  proposalId: string;
  questionId: string;
  text: string;
  answeredBy: string;
  answeredAt: Date;
  /**
   * An answer that does not answer the question is common enough to design for: a reviewer marks
   * it insufficient and the app re-asks, rather than accepting anything typed into the box.
   */
  sufficiency: "accepted" | "insufficient" | "pending-review";
  reAskNote: string | null;
  /** Set when a kind:"fact" answer has been promoted into the KB. */
  promotedToFactId: string | null;
};

export function sectionsInOrder(sections: Section[]): Section[] {
  return [...sections].sort((a, b) => a.ordinal - b.ordinal);
}

export function blocksInOrder(section: Section): Block[] {
  return [...section.blocks].sort((a, b) => a.ordinal - b.ordinal);
}

export function allBlocks(sections: Section[]): Block[] {
  return sectionsInOrder(sections).flatMap((s) => blocksInOrder(s));
}
