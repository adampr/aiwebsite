/**
 * The knowledge base: the structured replacement for xlnet-profile.md.
 *
 * The design commitment that matters here is that a fact is a record, not a sentence. Facts are
 * individually addressable, individually timestamped, and cited by ID from the blocks that use
 * them. That is what makes "which live proposals contain the thing Adam just corrected?" a query
 * rather than a grep, and the grep is what failed when a four-day-old proposal turned out to carry
 * four separately-corrected errors.
 */

import type { Money } from "./money";

/**
 * The knowledge base is append-mostly and versioned as a whole, so a proposal can record what it
 * was drafted against. A cheap approximation of temporal tables, sufficient because the only
 * question the app asks is "has anything changed since this draft," never "reconstruct the KB as
 * of last March."
 */
export type KbVersion = {
  id: string;
  /** Monotonic; compare with < and >. */
  seq: number;
  createdAt: Date;
  note: string | null;
};

export type FactCategory =
  /** headcount, offices, tenure, retention */
  | "firmography"
  /** what XL.net does and does not do */
  | "capability"
  /** certifications, insurance, frameworks */
  | "compliance"
  /** contract term, notice period, billing structure */
  | "commercial"
  /** service desk hours, staffing locations, onboarding sequence */
  | "operations"
  /** named products in the stack */
  | "tooling";

export const FACT_CATEGORIES = [
  "firmography",
  "capability",
  "compliance",
  "commercial",
  "operations",
  "tooling",
] as const satisfies readonly FactCategory[];

export type Fact = {
  id: string;
  /** Stable slug: "contract.term", "pricing.minimum-users". */
  key: string;
  category: FactCategory;
  /** The canonical assertion, in prose, as it should be understood. */
  statement: string;
  /**
   * Negative facts are first-class records, not absences. "XL.net does not offer dark web
   * monitoring" is knowledge: it is the difference between a drafter correctly declining to claim
   * it and a drafter inventing it because nothing said otherwise. Rule A6 reads this field.
   */
  polarity: "affirmative" | "negative";
  /** Nuance a drafter needs but that is not the claim itself. */
  detail: string | null;
  /** For externally verifiable facts (EOL dates, product docs). */
  sourceUrl: string | null;
  /** When the source was last actually checked. */
  verifiedAt: Date | null;
  /**
   * Distinct from updatedAt. A fact that was merely rephrased is not interesting; a fact whose
   * VALUE was wrong and has been fixed is extremely interesting, because every proposal drafted
   * before that moment may be repeating the error. Rule C1's whole query keys off this.
   */
  correctedAt: Date | null;
  /** Fact.id of the wrong version, kept for audit. */
  supersedes: string | null;
  introducedInKb: number;
  retiredInKb: number | null;
  /**
   * "needs-adam" marks a fact the app inferred or that a user entered without authority. Usable
   * in a draft, but it appears in the status doc's open questions and in the gate as an INFO.
   * This is what stops the KB quietly accumulating plausible inventions.
   */
  confidence: "confirmed" | "needs-adam";
};

/**
 * Client references are separated from facts because they carry contact PII and have their own
 * etiquette rules (D3: contact details released at contract stage, not proposal stage).
 */
export type Reference = {
  id: string;
  organization: string;
  website: string | null;
  /** "nonprofit", "manufacturing association", "distribution" */
  segment: string;
  contactName: string;
  contactTitle: string;
  contactPhone: string | null;
  contactEmail: string | null;
  relationshipSince: string | null;
  usableWithoutAsking: boolean;
  notes: string | null;
  /** Caring Network is retired, not deleted: a reference in a sent proposal must stay resolvable. */
  retiredAt: Date | null;
  /** Reference.id — Illinois Humanities replaced Caring Network. */
  replacedBy: string | null;
};

export type RateCardItem = {
  /** "fully-managed-user", "m365-only-user", "xl-secure-plus" */
  code: string;
  label: string;
  unitPrice: Money;
  /** "user/month", "computer/month", "one-time" */
  unit: string;
  note: string | null;
};

export type RateCard = {
  id: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  /** 15 */
  minimumFullyManagedUsers: number;
  /**
   * 370500 cents. Stored as its own field rather than computed as 15 x unitPrice, because it is a
   * business floor that happens to currently equal that product. If the per-user rate changes the
   * floor does not automatically follow; Adam decides. Rule B2 reads this field.
   */
  minimumMonthlyFee: Money;
  items: RateCardItem[];
};

export type QuestionCategory = "client" | "pricing" | "capability" | "firm-fact" | "business-term";

export type Question = {
  id: string;
  text: string;
  category: QuestionCategory;
  /** If set and that fact exists, do not ask. */
  answeredByFactKey: string | null;
  /**
   * The enforcement mechanism for the facts-versus-choices distinction. A "fact" answer is a
   * durable truth about XL.net and promotes into the KB on confirmation. A "choice" answer is a
   * decision about THIS proposal and never does. Promoting a choice pollutes the KB with one
   * client's preference; failing to promote a fact means asking Adam the same thing every quarter.
   */
  kind: "fact" | "choice";
  required: boolean;
  askOrder: number;
};

/** Everything the drafting layer and the validators read, at one KB version. */
export type KnowledgeSnapshot = {
  kbVersion: number;
  facts: Fact[];
  references: Reference[];
  rateCard: RateCard;
  questions: Question[];
};

export function factByKey(snapshot: KnowledgeSnapshot, key: string): Fact | undefined {
  return snapshot.facts.find((f) => f.key === key && f.retiredInKb === null);
}

export function rateCardItem(rateCard: RateCard, code: string): RateCardItem {
  const item = rateCard.items.find((i) => i.code === code);
  if (!item) {
    throw new Error(`Rate card ${rateCard.id} has no item with code "${code}"`);
  }
  return item;
}

/** Facts whose value was corrected. The C1 sweep starts here. */
export function correctedFacts(snapshot: KnowledgeSnapshot): Fact[] {
  return snapshot.facts
    .filter((f) => f.correctedAt !== null)
    .sort((a, b) => (a.correctedAt!.getTime() - b.correctedAt!.getTime()) || a.key.localeCompare(b.key));
}

export function negativeFacts(snapshot: KnowledgeSnapshot): Fact[] {
  return snapshot.facts.filter((f) => f.polarity === "negative" && f.retiredInKb === null);
}

export function activeReferences(snapshot: KnowledgeSnapshot): Reference[] {
  return snapshot.references.filter((r) => r.retiredAt === null);
}
