// Pure decision + parsing helpers for the §5.16 bulk ownership-transfer
// operator script (scripts/work-transfer.ts). Deliberately DB-free: test:work
// unit-tests every branch here without a database, and the script stays a
// thin loop around the same gates the web verb uses. The gates themselves
// are IMPORTED, never re-derived: transferTarget and transferBlockedReason
// are the route's own (src/lib/work/transfer.ts), WORK_SUBMIT_DOMAINS is the
// staff lane's one domain list, and the --actor address goes through the
// same transferTarget shape checks a recipient does. If the route's policy
// moves, this file moves with it by construction.

import { WORK_SUBMIT_DOMAINS } from "../../src/lib/work/http";
import {
  sameEmail,
  transferBlockedReason,
  transferTarget,
} from "../../src/lib/work/transfer";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How the refusal copy names the staff lane; the route's literal. */
export const STAFF_LANE_LABEL = "the Our Work page";

// ── Plan file ──────────────────────────────────────────────────────

export type TransferPlanRow = {
  /** Submission uuid, lowercased. */
  id: string;
  /** The intended new owner, as written in the plan (validated per row by
   * decideTransfer against the row's lane, never here). */
  to: string;
  /** Free text for the operator's eyes: who the canvas credits, why. */
  note: string;
};

export type TransferPlanParse =
  | { ok: true; rows: TransferPlanRow[] }
  | { ok: false; error: string };

const PLAN_KEYS = new Set(["id", "to", "note"]);

/**
 * Validate a parsed plan document: a non-empty JSON array of
 * {id, to, note?} objects, no unknown keys, no duplicate ids. Loud on every
 * shape error, naming the offending index, because a plan file is typed by
 * hand from a canvas and a silently ignored key ("too" for "to") would move
 * nothing while looking complete.
 */
export function parseTransferPlan(json: unknown): TransferPlanParse {
  if (!Array.isArray(json))
    return { ok: false, error: "the plan must be a JSON array of rows" };
  if (json.length === 0) return { ok: false, error: "the plan has no rows" };
  const rows: TransferPlanRow[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < json.length; i++) {
    const raw: unknown = json[i];
    const at = `row ${i}`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return { ok: false, error: `${at}: must be an object {id, to, note}` };
    const obj = raw as Record<string, unknown>;
    for (const k of Object.keys(obj))
      if (!PLAN_KEYS.has(k))
        return {
          ok: false,
          error: `${at}: unknown key "${k}" (allowed: id, to, note)`,
        };
    const id = obj.id;
    if (typeof id !== "string" || !UUID_RE.test(id))
      return { ok: false, error: `${at}: id must be a submission uuid` };
    const idKey = id.toLowerCase();
    if (seen.has(idKey))
      return { ok: false, error: `${at}: duplicate id ${idKey}` };
    seen.add(idKey);
    const to = obj.to;
    if (typeof to !== "string" || to.trim() === "")
      return { ok: false, error: `${at} (${idKey.slice(0, 8)}): "to" must be an email address` };
    const note = obj.note;
    if (note !== undefined && typeof note !== "string")
      return { ok: false, error: `${at} (${idKey.slice(0, 8)}): "note" must be a string` };
    rows.push({ id: idKey, to: to.trim(), note: note ?? "" });
  }
  return { ok: true, rows };
}

// ── Per-row decision ───────────────────────────────────────────────

/** The facts the decision reads off a FRESH submissionById read. `stale`
 * is statusView(row).stale, computed by the caller (it needs the row's
 * heartbeat and the clock, both of which the script has and this pure
 * module deliberately does not). */
export type TransferDecisionRow = {
  id: string;
  title: string;
  status: string;
  submitterEmail: string;
  companyId: string | null;
  panelAttemptId: string | null;
  stale: boolean;
};

export type TransferVerdict =
  | { verdict: "move"; from: string; to: string }
  | { verdict: "skip"; reason: string }
  | { verdict: "refuse"; reason: string };

/**
 * Decide one plan row, in the ROUTE's order: existence, lane, target,
 * state. Returns what the script prints and, for "move", the exact
 * addresses the compare-and-swap will be pinned on.
 *
 *  - refuse: the row cannot be moved by this script (missing; company lane,
 *    which needs the company's own domain as the lane and is the web
 *    control's job; a target the staff lane rejects; superseded or mid-run).
 *    Reported, never written, and NOT an error exit: a plan that names such
 *    rows is disclosed, not failed.
 *  - skip: the row already belongs to the plan's target. A no-op that the
 *    route would refuse with "already owns"; here it is the normal shape of
 *    a re-run after a partial apply, so it is not a refusal.
 *  - move: everything the route checks agrees.
 */
export function decideTransfer(
  row: TransferDecisionRow | null,
  to: string,
  laneDomains: readonly string[] = WORK_SUBMIT_DOMAINS
): TransferVerdict {
  if (!row) return { verdict: "refuse", reason: "no such submission" };
  if (row.companyId !== null)
    return {
      verdict: "refuse",
      reason:
        "company-lane row (company_id is set); this script only moves public /work rows. Use Move to someone else on the site, which derives the lane from the company.",
    };
  if (sameEmail(row.submitterEmail, to))
    return { verdict: "skip", reason: "already owns it" };
  const target = transferTarget({
    raw: to,
    laneDomains,
    currentOwner: row.submitterEmail,
    laneLabel: STAFF_LANE_LABEL,
  });
  if (!target.ok) return { verdict: "refuse", reason: target.message };
  const blocked = transferBlockedReason({
    status: row.status,
    stale: row.stale,
  });
  if (blocked) return { verdict: "refuse", reason: blocked };
  return { verdict: "move", from: row.submitterEmail, to: target.email };
}

// ── argv ───────────────────────────────────────────────────────────

export type TransferArgs = {
  plan: string;
  apply: boolean;
  /** Lowercased, validated staff-lane address; null on a dry run without
   * --actor. */
  actor: string | null;
  notify: boolean;
  yes: boolean;
};

export type TransferArgsParse =
  | { ok: true; args: TransferArgs }
  | { ok: false; error: string };

/**
 * `<plan.json> [--apply] [--actor <email>] [--notify] [--yes]`.
 * --actor is mandatory with --apply because the [work] transferred log line
 * and the new-owner email both name who did it, and a batch with no actor
 * would print by=undefined into the audit trail. --notify without --apply is
 * refused rather than ignored: a dry run that says "emails will be sent"
 * and sends none is the kind of half-truth an operator acts on.
 */
export function parseTransferArgs(argv: string[]): TransferArgsParse {
  let plan: string | null = null;
  let apply = false;
  let actorRaw: string | null = null;
  let notify = false;
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") apply = true;
    else if (a === "--notify") notify = true;
    else if (a === "--yes") yes = true;
    else if (a === "--actor") {
      const v = argv[i + 1];
      if (!v || v.startsWith("--"))
        return { ok: false, error: "--actor needs an email address" };
      if (actorRaw !== null) return { ok: false, error: "--actor given twice" };
      actorRaw = v;
      i++;
    } else if (a.startsWith("--"))
      return { ok: false, error: `unknown flag ${a}` };
    else if (plan === null) plan = a;
    else return { ok: false, error: `unexpected argument ${a}` };
  }
  if (!plan) return { ok: false, error: "a plan file path is required" };
  let actor: string | null = null;
  if (actorRaw !== null) {
    // The actor lands verbatim in the audit log line and in the new-owner
    // email body, so it gets the SAME shape checks a transfer target gets
    // (whitespace, quoted local part, dot rules, exact lane domain), not
    // just a domain parse. currentOwner is "" so the no-op branch cannot
    // fire.
    const shaped = transferTarget({
      raw: actorRaw,
      laneDomains: WORK_SUBMIT_DOMAINS,
      currentOwner: "",
      laneLabel: "the Our Work page",
    });
    if (!shaped.ok)
      return {
        ok: false,
        error: `--actor must be a deliverable address at ${WORK_SUBMIT_DOMAINS.join(", ")} (the person doing the move): ${shaped.message}`,
      };
    actor = shaped.email;
  }
  if (apply && actor === null)
    return { ok: false, error: "--apply needs --actor <email>" };
  if (notify && !apply)
    return { ok: false, error: "--notify only means something with --apply" };
  return { ok: true, args: { plan, apply, actor, notify, yes } };
}
