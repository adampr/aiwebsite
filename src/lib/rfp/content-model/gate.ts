/**
 * Artifacts and the compliance gate's output types.
 *
 * The gate's output is a first-class object with a stable rule ID per finding, not a log: the
 * review UI shows it, a human can override a warning with a recorded reason, and the history is
 * worth keeping.
 */

export type ArtifactFormat = "pdf" | "docx" | "html-bundle" | "status-doc";

export type Artifact = {
  id: string;
  proposalId: string;
  format: ArtifactFormat;
  blobKey: string;
  /** "XLnet CHF Proposal - Managed IT Services.pdf" */
  filename: string;
  /** pdf only. */
  pageCount: number | null;
  /**
   * Hashes the CONTENT MODEL the artifact was emitted from, not the file bytes. Two artifacts of
   * the same proposal in different formats must share a hash; if they do not, they were built from
   * different states and rule C2 has been violated. This makes cross-format parity a single
   * equality check instead of a text-diffing script.
   */
  contentHash: string;
  builtAt: Date;
  builtFromKbVersion: number;
  supersededBy: string | null;
};

export type Severity = "block" | "warn" | "info";

export type ViolationLocator = {
  sectionId?: string;
  blockId?: string;
  /** Which text span inside the block, e.g. "rows[3][1]" or "body". */
  field?: string;
  pricingLineId?: string;
  findingId?: string;
  requirementId?: string;
  charOffset?: number;
};

export type Violation = {
  /** "A1", "B2" — stable, matching DOMAIN-RULES.md exactly. */
  ruleId: string;
  severity: Severity;
  message: string;
  /** Where it is, precisely enough to click through. */
  locator: ViolationLocator;
  /** The offending text, when there is one, for display in the review UI. */
  excerpt?: string;
  /** What to write instead, where the rule knows. */
  suggestion?: string;
  overriddenBy: string | null;
  overrideReason: string | null;
};

export type GateRun = {
  id: string;
  proposalId: string;
  ranAt: Date;
  passed: boolean;
  violations: Violation[];
};

/**
 * A block violation cannot be overridden. A warn can, with a reason, and the override is recorded
 * on the proposal rather than discarded: if the same warning is overridden on every proposal, the
 * rule is wrong and should be changed rather than routinely ignored.
 */
export function canOverride(violation: Violation): boolean {
  return violation.severity !== "block";
}

export function isOverridden(violation: Violation): boolean {
  return canOverride(violation) && violation.overriddenBy !== null;
}

/** The gate passes when no blocking violation remains and every warning is either clean or overridden. */
export function gatePasses(violations: Violation[]): boolean {
  return !violations.some((v) => v.severity === "block" || (v.severity === "warn" && !isOverridden(v)));
}

export function blockingViolations(violations: Violation[]): Violation[] {
  return violations.filter((v) => v.severity === "block");
}

export function violationsByRule(violations: Violation[]): Map<string, Violation[]> {
  const map = new Map<string, Violation[]>();
  for (const v of violations) {
    const existing = map.get(v.ruleId);
    if (existing) existing.push(v);
    else map.set(v.ruleId, [v]);
  }
  return map;
}
