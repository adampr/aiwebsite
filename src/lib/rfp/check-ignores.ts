// Persisted check dismissals (ARCHITECTURE.md §5.17.8).
//
// The Checks pane's Ignore action records a finding as dismissed FOR THIS
// PROPOSAL, and the mark must survive gate re-runs: the rules recompute every
// violation from scratch, so the only way to keep an ignored finding ignored
// is to re-match it by a stable signature and re-apply the mark every time a
// result is stored (gate-run.ts and the export route, the two store sites —
// they must never disagree, or the pane would show "passing" while the export
// header said otherwise).
//
// PURE module: imported by a client component (workspace.tsx, which computes
// each row's signature to post it) AND by server code. No server imports, no
// db, no node builtins, no lookbehind regexes. Keep it that way — same
// contract as gaps.ts.

import type { Violation } from "./content-model/gate";
import type { GateResult } from "./validators/gate";

/**
 * The stable signature of one finding. Treat as a PERSISTED FORMAT (the
 * gaps.ts normalizer discipline): stored `checks_ignores_json` rows key on
 * it, so changing the recipe un-ignores every dismissal on live proposals.
 *
 * The signature is the rule id, the full locator, and a normalized slice of
 * the finding's own text. That choice is deliberate: an edit that moves or
 * changes the offending text changes the signature, so a CHANGED finding
 * correctly resurfaces as new, while the byte-identical finding on the next
 * run re-matches and stays dismissed.
 */
export function findingSig(v: Violation): string {
  // Total over shape-corrupt input: this runs on every violation of a STORED
  // gate_json row (the workspace render and applyIgnores both call it), and a
  // hand-corrupted or shape-drifted row must degrade to a nonsense signature,
  // never throw mid-render or mid-transaction. The fallbacks cannot change
  // any real persisted sig: violation() always sets message and locator.
  const loc: Violation["locator"] = v.locator ?? {};
  const textKey = String(v.excerpt ?? v.message ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  return [
    v.ruleId,
    loc.sectionId ?? "",
    loc.blockId ?? "",
    loc.field ?? "",
    loc.pricingLineId ?? "",
    loc.requirementId ?? "",
    loc.charOffset === undefined ? "" : String(loc.charOffset),
    textKey,
  ].join("\u0000");
}

/** One stored dismissal. `note` is the violation's message sliced to 200 for
 *  the Ignored list; `at` is an ISO instant. */
export type CheckIgnore = {
  sig: string;
  ruleId: string;
  note: string;
  by: string;
  at: string;
};

/** Bound on stored dismissals per proposal; appendIgnore evicts the oldest
 *  beyond it, so the column cannot grow without limit. */
export const MAX_CHECK_IGNORES = 200;

/** Tolerant reader for the stored column: [] on null, garbage, or a
 *  non-array, and every field type-checked per entry — a malformed entry is
 *  dropped, never thrown on. */
export function parseCheckIgnores(json: string | null): CheckIgnore[] {
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: CheckIgnore[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (
      typeof r.sig !== "string" ||
      typeof r.ruleId !== "string" ||
      typeof r.note !== "string" ||
      typeof r.by !== "string" ||
      typeof r.at !== "string"
    )
      continue;
    out.push({ sig: r.sig, ruleId: r.ruleId, note: r.note, by: r.by, at: r.at });
  }
  return out.slice(0, MAX_CHECK_IGNORES);
}

/** Append one dismissal: dedupe by sig (the new entry replaces the old one's
 *  place in line), then evict the OLDEST entries beyond the cap. */
export function appendIgnore(
  list: CheckIgnore[],
  entry: CheckIgnore
): CheckIgnore[] {
  const next = [...list.filter((e) => e.sig !== entry.sig), entry];
  return next.length > MAX_CHECK_IGNORES
    ? next.slice(next.length - MAX_CHECK_IGNORES)
    : next;
}

/**
 * Re-apply stored dismissals to a fresh gate result. Returns a NEW result:
 *
 *   - a violation whose signature matches an ignore gains
 *     `dismissed: { by, at }` from that ignore;
 *   - a violation NOT in the set has any stale `dismissed` field REMOVED —
 *     a restore must clear the mark on the next re-apply, and a stored
 *     result being re-processed must not keep marks whose ignores are gone;
 *   - `passed` is recomputed over the surviving (undismissed) violations,
 *     preserving the content-model gatePasses semantics: block always
 *     fails, warn fails unless overridden, info never blocks, and a
 *     validator error always fails regardless of dismissals.
 */
export function applyIgnores(
  result: GateResult,
  ignores: CheckIgnore[]
): GateResult {
  const bySig = new Map(ignores.map((e) => [e.sig, e]));
  const violations: Violation[] = result.violations.map((v): Violation => {
    const hit = bySig.get(findingSig(v));
    if (hit) return { ...v, dismissed: { by: hit.by, at: hit.at } };
    if (v.dismissed === undefined) return v;
    // Stale mark: DELETED, not set undefined — the result is JSON.stringify'd
    // into gate_json, and the absent-key shape is the one that round-trips
    // (the violation() builder's own convention).
    const rest = { ...v };
    delete rest.dismissed;
    return rest;
  });
  const passed =
    result.errors.length === 0 &&
    !violations.some(
      (v) =>
        !v.dismissed &&
        (v.severity === "block" ||
          (v.severity === "warn" && !(v.overriddenBy !== null)))
    );
  // failedRules follows the SURVIVING violations, so the stored result stays
  // internally consistent: passed:true with failedRules naming fully-dismissed
  // rules would hand any future consumer a contradiction.
  const failedRules = [
    ...new Set(violations.filter((v) => !v.dismissed).map((v) => v.ruleId)),
  ].sort();
  return { ...result, passed, failedRules, violations };
}
