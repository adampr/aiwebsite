/**
 * The compliance gate.
 *
 * Runs against the content model before any emitter. Blocking violations prevent export; warnings
 * surface in the review UI and can be overridden with a recorded reason.
 */

import { gatePasses, type GateRun, type Violation } from "@/lib/rfp/content-model";
import { A_RULES } from "./rules-a";
import { B_RULES } from "./rules-b";
import { C_RULES } from "./rules-c";
import { D_RULES } from "./rules-d";
import type { Rule, ValidationContext } from "./rule";

/** Every rule, in documentation order. */
export const ALL_RULES: Rule[] = [...A_RULES, ...B_RULES, ...C_RULES, ...D_RULES];

export const RULE_IDS: string[] = ALL_RULES.map((r) => r.id);

export function ruleById(id: string): Rule | undefined {
  return ALL_RULES.find((r) => r.id === id);
}

export type GateResult = {
  passed: boolean;
  violations: Violation[];
  /** Rule IDs that produced at least one violation, for the review UI's summary. */
  failedRules: string[];
  /** Rules that threw. A validator crashing must not be mistaken for a clean document. */
  errors: { ruleId: string; message: string }[];
};

/**
 * Run every rule.
 *
 * A rule that throws is reported as an ERROR and the gate does not pass. Swallowing the exception
 * and continuing would let a broken validator read as a clean document, which is the failure mode
 * the whole gate exists to prevent.
 */
export function runGate(ctx: ValidationContext, options: { only?: string[] } = {}): GateResult {
  const rules = options.only ? ALL_RULES.filter((r) => options.only!.includes(r.id)) : ALL_RULES;

  const violations: Violation[] = [];
  const errors: GateResult["errors"] = [];

  for (const rule of rules) {
    try {
      violations.push(...rule.check(ctx));
    } catch (error) {
      errors.push({
        ruleId: rule.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const failedRules = [...new Set(violations.map((v) => v.ruleId))].sort();

  return {
    passed: errors.length === 0 && gatePasses(violations),
    violations,
    failedRules,
    errors,
  };
}

export function toGateRun(proposalId: string, result: GateResult, ranAt: Date): GateRun {
  return {
    id: `gate_${proposalId}_${ranAt.getTime()}`,
    proposalId,
    ranAt,
    passed: result.passed,
    violations: result.violations,
  };
}

/**
 * Apply a recorded override to a warning.
 *
 * A block violation can never be overridden. The override is recorded on the proposal rather than
 * discarded: if the same warning is overridden on every proposal, the rule is wrong and should be
 * changed rather than routinely ignored.
 */
export function overrideWarning(
  violation: Violation,
  by: string,
  reason: string,
): Violation {
  if (violation.severity === "block") {
    throw new Error(
      `Rule ${violation.ruleId} is a blocking violation and cannot be overridden. Fix the content.`,
    );
  }
  if (!reason.trim()) {
    throw new Error("An override requires a recorded reason.");
  }
  return { ...violation, overriddenBy: by, overrideReason: reason };
}

/** Human-readable gate report, for the CLI and the status doc. */
export function formatGateResult(result: GateResult): string {
  const lines: string[] = [];
  lines.push(result.passed ? "GATE PASSED" : "GATE FAILED");

  if (result.errors.length > 0) {
    lines.push("", `${result.errors.length} VALIDATOR ERROR(S):`);
    for (const error of result.errors) {
      lines.push(`  ${error.ruleId}: ${error.message}`);
    }
  }

  const bySeverity = { block: 0, warn: 0, info: 0 };
  for (const v of result.violations) bySeverity[v.severity] += 1;
  lines.push(
    "",
    `${bySeverity.block} blocking, ${bySeverity.warn} warning, ${bySeverity.info} advisory`,
  );

  for (const severity of ["block", "warn", "info"] as const) {
    const group = result.violations.filter((v) => v.severity === severity);
    if (group.length === 0) continue;
    lines.push("", severity.toUpperCase());
    for (const v of group) {
      const where = v.locator.blockId
        ? ` [${v.locator.blockId}${v.locator.field ? `.${v.locator.field}` : ""}]`
        : "";
      lines.push(`  ${v.ruleId}${where}  ${v.message}`);
      if (v.excerpt) lines.push(`      "${v.excerpt.replace(/\s+/g, " ")}"`);
      if (v.suggestion) lines.push(`      -> ${v.suggestion}`);
    }
  }

  return lines.join("\n");
}
