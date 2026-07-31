/**
 * Environment audit types.
 *
 * When the RFP includes a current-environment inventory, that table is the highest-value page in
 * the finished document. Competitors quote it back; the winning move is to interrogate it.
 *
 * Two constraints belong to this file and are enforced in code rather than left to reviewers:
 * a date-based finding without a stored evidenceUrl may not reach the client, and planFraming is
 * required because the proposal never prints `statement` directly.
 */

export type EnvironmentCategory =
  | "firewall"
  | "switch"
  | "server"
  | "workstation"
  | "os"
  | "saas"
  | "backup"
  | "identity"
  | "other";

export type EnvironmentItem = {
  id: string;
  proposalId: string;
  /** Verbatim from the RFP inventory. */
  rawText: string;
  category: EnvironmentCategory;
  vendor: string | null;
  model: string | null;
  version: string | null;
  quantity: number | null;
  statedPurpose: string | null;
  /** Where in the RFP it appeared, for count-disagreement checks. */
  sourceLocation: string;
};

export type FindingCheckType =
  | "end-of-support"
  | "sync-as-backup"
  | "licensing-mismatch"
  | "category-error"
  | "count-disagreement"
  | "single-point-of-failure"
  | "client-flagged-gap";

export const FINDING_CHECK_TYPES = [
  "end-of-support",
  "sync-as-backup",
  "licensing-mismatch",
  "category-error",
  "count-disagreement",
  "single-point-of-failure",
  "client-flagged-gap",
] as const satisfies readonly FindingCheckType[];

/** Check types whose claim is a date and therefore require external evidence before assertion. */
export const DATE_BASED_CHECK_TYPES: readonly FindingCheckType[] = ["end-of-support"];

export type Finding = {
  id: string;
  proposalId: string;
  /** Count disagreements cite two or more. */
  environmentItemIds: string[];
  checkType: FindingCheckType;
  severity: "critical" | "elevated" | "informational";
  /** What is true. Never printed directly. */
  statement: string;
  /** REQUIRED for date-based findings. */
  evidenceUrl: string | null;
  evidenceVerifiedAt: Date | null;
  /**
   * How it appears in the proposal: a plan item, not a criticism. The Cisco ASA 5512-X finding
   * says "we would plan a firewall refresh in the first ninety days," not "your firewall is nine
   * years past end-of-support." Making the field mandatory means the drafter cannot skip the
   * translation step.
   */
  planFraming: string;
  includeInProposal: boolean;
};

export class FindingEvidenceError extends Error {
  constructor(
    message: string,
    readonly findingId: string,
  ) {
    super(message);
    this.name = "FindingEvidenceError";
  }
}

/**
 * The two structural constraints on findings, enforced rather than reviewed.
 *
 * Being confidently wrong about a prospect's own firewall, in front of the person who bought it,
 * ends a candidacy. Verify, store the URL, then assert.
 */
export function assertFindingPublishable(finding: Finding): void {
  if (!finding.includeInProposal) return;

  if (DATE_BASED_CHECK_TYPES.includes(finding.checkType)) {
    if (!finding.evidenceUrl) {
      throw new FindingEvidenceError(
        `Finding ${finding.id} is a ${finding.checkType} claim with no evidenceUrl and cannot be included in a proposal`,
        finding.id,
      );
    }
    if (!finding.evidenceVerifiedAt) {
      throw new FindingEvidenceError(
        `Finding ${finding.id} has an evidenceUrl but no evidenceVerifiedAt; the source must actually have been checked`,
        finding.id,
      );
    }
  }

  if (!finding.planFraming.trim()) {
    throw new FindingEvidenceError(
      `Finding ${finding.id} has no planFraming; the proposal never prints the raw statement`,
      finding.id,
    );
  }
}

export function publishableFindings(findings: Finding[]): Finding[] {
  const publishable = findings.filter((f) => f.includeInProposal);
  publishable.forEach(assertFindingPublishable);
  return publishable;
}
