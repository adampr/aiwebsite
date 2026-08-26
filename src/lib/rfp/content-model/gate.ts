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

/**
 * A violation message SPLIT at the instants it names, so a client can render each
 * one in the VIEWER's timezone (§5.17) instead of shipping the server's day inside
 * a string.
 *
 * Why a structure and not a formatted string: a plain string cannot hold a React
 * element, and `message` is built on the server, where the runtime zone is the VM's
 * UTC. Rule C1 named two stored instants as bare UTC calendar days, so a Chicago
 * staffer who corrected a fact at 21:30 on Jul 26 (2026-07-27T02:30:00Z) read
 * "Corrected Jul 26, 2026, 09:30 PM CDT" on /rfp/knowledge and "corrected on
 * 2026-07-27" in the same workspace's Checks pane. One instant, two consoles, two
 * days. C1's ENTIRE payload is the ORDERING of those two days ("corrected on X,
 * after this was drafted on Y"), so a shifted day is the point of the sentence.
 *
 * Shape follows the `CheckLine {before, iso, after}` precedent in
 * `src/lib/roadmap/platform-copy.ts` (rendered by `platform-islands.tsx`),
 * generalised to N instants because C1 names two: each segment is the prose that
 * PRECEDES its instant, and `after` is everything past the last one.
 */
export type TimedMessage = {
  segments: { before: string; iso: string }[];
  after: string;
};

/**
 * The flat form of a TimedMessage, with every instant rendered as an explicitly
 * LABELLED UTC day.
 *
 * `message` is derived from the split form through this rather than written twice,
 * so the two can never drift apart. The label is not decoration: this string is the
 * degraded path (a `gate_json` row stored before `timedMessage` existed, and
 * `formatGateResult`'s terminal report), and an unlabelled day silently implies the
 * reader's own day, which is the exact defect this type exists to close.
 */
export function flattenTimedMessage(timed: TimedMessage): string {
  return (
    timed.segments.map((s) => `${s.before}${s.iso.slice(0, 10)} (UTC)`).join("") +
    timed.after
  );
}

export type Violation = {
  /** "A1", "B2" — stable, matching DOMAIN-RULES.md exactly. */
  ruleId: string;
  severity: Severity;
  /**
   * The complete sentence, always present and always self-sufficient. Consumers
   * without JSX (formatGateResult) read only this.
   */
  message: string;
  /**
   * Present ONLY on rules that name a stored instant; today that is C1 alone, the
   * only rule in the 26 that puts a date in its message. A JSX consumer renders
   * these segments through `<LocalTime withTime>` and ignores `message`; every
   * other consumer ignores this and reads `message`.
   *
   * OPTIONAL by construction, because a GateResult is serialised whole into
   * `rfp_proposals.gate_json` (a text column holding JSON, so this is an additive
   * field and NOT a migration). A gate run stored before 2026-08-26 simply lacks it
   * and falls back to `message`; re-running the gate replaces the row.
   */
  timedMessage?: TimedMessage;
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
