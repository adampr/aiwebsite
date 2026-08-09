// §5.16 submission transfer (owner directive 2026-08-09: "allow any user
// from their submissions to move the work to someone else, as if they only
// submitted on their behalf"). PURE: no DB, no session, no imports beyond
// the strict email parser, so scripts/work-tests.ts drives every branch.
//
// The one invariant this file exists to hold: THE LANE COMES FROM THE ROW,
// NEVER FROM THE CALLER. A public /work row (company_id IS NULL) may only
// move to an xl.net address, and a company row may only move inside that
// company's own domain. Anything else would either hand a row to someone
// with no surface that can render it (a non-staff owner cannot open
// /work/submit at all) or move a private tenant's card across tenancy.

import { emailDomain } from "@/lib/rfp/access";
import { isTransferableStatus } from "./config";

/** RFC 5321's practical ceiling. Checked before anything looks at shape so
 * a pathological paste never reaches the parser or an email body. */
const EMAIL_MAX_CHARS = 254;

export type TransferTarget =
  | { ok: true; email: string }
  | { ok: false; code: string; message: string };

/**
 * Email identity, case-folded. THE reason this exists: every ownership gate
 * in §5.16 used raw `===` against submitter_email, which was safe only
 * because every row's address arrived verbatim from the same OAuth session
 * that later reads it. A transfer stores a TYPED address, so "Jane@xl.net"
 * signing in against a row stored as "jane@xl.net" would 404 on her own
 * submission. Local parts are case-insensitive at every provider this site
 * admits, and the roadmap scorecard has always grouped on
 * lower(submitter_email), so this makes the rest of the system agree with
 * the half that was already folding.
 */
export function sameEmail(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Canonical stored form. Lowercased because every downstream reader that
 * matters is already case-folding (the scorecard groups on
 * lower(submitter_email); canProposeUpdate lowercases) and because the
 * typed-in address here has no OAuth provider to canonicalize it. */
export function normalizeOwnerEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Validate a typed transfer target against the ROW's lane.
 *
 * @param raw            what the actor typed
 * @param laneDomains    the domains this row's lane admits (staff lane:
 *                       WORK_SUBMIT_DOMAINS; company lane: exactly that
 *                       company's registered domain)
 * @param currentOwner   the row's submitter_email, so a no-op move is named
 *                       rather than burning a write and two emails
 * @param laneLabel      how the refusal names the lane to a human
 */
export function transferTarget(opts: {
  raw: unknown;
  laneDomains: readonly string[];
  currentOwner: string;
  laneLabel: string;
}): TransferTarget {
  const { laneDomains, currentOwner, laneLabel } = opts;
  if (typeof opts.raw !== "string")
    return {
      ok: false,
      code: "invalid_request",
      message: "Send the new owner's email address.",
    };
  const raw = opts.raw.trim();
  if (!raw)
    return {
      ok: false,
      code: "invalid_request",
      message: "Enter the email address of the person this should belong to.",
    };
  if (raw.length > EMAIL_MAX_CHARS)
    return {
      ok: false,
      code: "invalid_request",
      message: "That email address is too long. Check it and try again.",
    };
  const email = normalizeOwnerEmail(raw);
  // emailDomain is the strict parser the /rfp and roadmap gates already use:
  // it rejects non-ASCII outright (a homoglyph domain must never render as
  // "xl.net" while comparing unequal), requires exactly one "@", and strips a
  // trailing root dot. A bare domain check with endsWith would admit
  // "evilxl.net"; this compares the whole label.
  const domain = emailDomain(email);
  const localPart = email.split("@")[0] ?? "";
  // Shape checks, deliberately NOT a character allowlist: Google Workspace
  // permits apostrophes and plus-addressing in a local part, and refusing a
  // real colleague is the worse error. What is rejected is the shape that
  // cannot be a deliverable address at all - a quoted local part (which the
  // rest of this file's folding and comparison would mangle), a leading,
  // trailing or doubled dot, and any whitespace.
  const badDots =
    localPart.startsWith(".") ||
    localPart.endsWith(".") ||
    localPart.includes("..") ||
    domain?.startsWith(".") === true ||
    domain?.includes("..") === true;
  if (
    domain === null ||
    !localPart ||
    /\s/.test(email) ||
    localPart.startsWith('"') ||
    badDots
  )
    return {
      ok: false,
      code: "invalid_request",
      message:
        "That does not look like an email address. Use the person's full work address, like name@xl.net.",
    };
  if (!laneDomains.includes(domain))
    return {
      ok: false,
      code: "invalid_target",
      message:
        laneDomains.length === 1
          ? `This submission lives on ${laneLabel}, so it can only be moved to an address at ${laneDomains[0]}.`
          : `This submission lives on ${laneLabel}, so it can only be moved to an address at one of: ${laneDomains.join(", ")}.`,
    };
  if (email === normalizeOwnerEmail(currentOwner))
    return {
      ok: false,
      code: "invalid_request",
      message: "That person already owns this submission.",
    };
  return { ok: true, email };
}

/**
 * Why this row cannot be moved right now, or null.
 *
 * Two refusals, for two different reasons:
 *  - `superseded` is a STRUCTURAL refusal (see TRANSFERABLE_STATUSES): the
 *    row is one dead generation of a supersede chain, and moving it would
 *    rewrite who may update the LIVE card. The copy sends the reader to the
 *    live version, which is the thing they actually meant to move.
 *  - a LIVE panel run is a TEMPORAL refusal: the run holds the row it read
 *    at claim time and addresses its published/held email to that copy's
 *    submitter_email, so a move mid-run would mail the outcome to the
 *    previous owner and tell the new one nothing. A run whose heartbeat has
 *    gone stale is NOT protected, or one crashed worker would make a row
 *    permanently unmovable.
 */
export function transferBlockedReason(row: {
  status: string;
  stale: boolean;
}): string | null {
  if (row.status === "superseded")
    return "This is the previous version of a card that has since been updated, and it stays where it is so the update can be rolled back. Move the live version instead: its row has the same option.";
  if (!isTransferableStatus(row.status))
    return "This submission cannot be moved in its current state.";
  if (row.status === "running" && !row.stale)
    return "This submission is being reviewed right now. Move it once the review finishes; it usually takes a few minutes.";
  return null;
}
