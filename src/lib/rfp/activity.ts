// Append-only RFP activity log (ARCHITECTURE.md §5.17).
//
// Logs SHAPE, never content. Ids, keys, counts, rule ids and outcomes go in;
// RFP body text, draft prose, fact statements, intake answers, model prompts
// and money figures never do. Otherwise this table becomes the one place
// confidential material accumulates outside the row that owns it.
//
// Denials are logged as well as successes. A horizontal-privilege probe (one
// user walking another's ids) shows up ONLY as a run of denied reads, so a
// success-only log would be blind to the attack it exists to catch.
//
// SECTION STRUCTURE LABELS ARE TREATED AS KEYS. `meta.section` carries the
// client's verbatim label ("4.2", "F.", occasionally a short phrase) because
// it is the section's identifier everywhere else in the system; the
// generate/edit/revise/gap paths all log it. A label is the closest thing a
// section has to an id, and correlating activity per section needs it. Body
// text, requirement text, and answers remain banned.
//
// There is deliberately no update and no delete helper. Best-effort by
// design: a logging failure must never fail the user's action, but it does
// console.error so a broken log is visible in pm2 output.

import { db } from "@/lib/db";
import { rfpActivity } from "@/lib/db/rfp-schema";

/** Closed vocabulary. Adding one is a deliberate act, not an ad-hoc string. */
export const RFP_ACTIONS = [
  "document.create",
  "document.extract",
  "document.confirm_structure",
  "document.archive",
  "document.unarchive",
  "document.delete",
  "proposal.create",
  "proposal.generate",
  "proposal.section_edit",
  "proposal.tron_revise",
  "proposal.tron_plan",
  "proposal.gap_resolve",
  "proposal.pricing_set",
  "proposal.gate_run",
  "proposal.export",
  "proposal.approve",
  "knowledge.propose",
  "knowledge.submit",
  "knowledge.approve",
  "knowledge.return",
  "knowledge.edit",
  "knowledge.correct",
  "knowledge.retire",
  "knowledge.add",
  "ratecard.edit",
  "question.edit",
  "admin.view_all",
  "access.denied",
] as const;

export type RfpAction = (typeof RFP_ACTIONS)[number];

const META_MAX = 1000;

export async function logRfpActivity(input: {
  actorEmail: string;
  actorAdmin?: boolean;
  action: RfpAction;
  subjectKind?: "document" | "proposal" | "fact" | "knowledge" | "section";
  subjectId?: string | null;
  outcome?: "ok" | "denied" | "error";
  /** Shape only. Never text the user wrote or the model produced. */
  meta?: Record<string, string | number | boolean | null>;
}): Promise<void> {
  try {
    let metaJson: string | null = null;
    if (input.meta) {
      const raw = JSON.stringify(input.meta);
      metaJson = raw.length > META_MAX ? raw.slice(0, META_MAX) : raw;
    }
    await db.insert(rfpActivity).values({
      actorEmail: input.actorEmail.toLowerCase(),
      actorAdmin: input.actorAdmin ?? false,
      action: input.action,
      subjectKind: input.subjectKind ?? null,
      subjectId: input.subjectId ?? null,
      outcome: input.outcome ?? "ok",
      metaJson,
    });
  } catch (err) {
    console.error(
      `[rfp] activity log write failed (${input.action}):`,
      err instanceof Error ? err.message : err
    );
  }
}
