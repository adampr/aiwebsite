// POST - MOVE a submission to another person (§5.16 transfer round, owner
// directive 2026-08-09: "allow any user from their submissions to move the
// work to someone else, as if they only submitted on their behalf", and
// "the admin can move any user's submission to be owned by another person").
//
// Shape follows the reorder route, which is this file's nearest precedent:
// the body carries ONE field, the LANE is derived from the ROW and never
// from client input, and a stale render costs a 409 rather than a wrong
// write. Two things it does NOT copy: this verb is open to the row's owner,
// not admin-only, and it is not silently reversible by the actor, so it
// emails everyone it affects.
//
// requireXlUser, not requireWorkUser: the only surface that offers this is
// /work/submit, which is staff-gated, so shipping the capability to company
// sessions would be a route with no page. An ADMIN is an xl.net account and
// still reaches company-lane rows here, with the lane predicate below
// keeping the recipient inside that company's own domain.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { after } from "next/server";
import {
  submissionById,
  transferSubmission,
  userIdForEmail,
} from "@/lib/work/db";
import { companyById } from "@/lib/roadmap/db";
import { isCompanyEligibleDomain } from "@/lib/roadmap/domains";
import {
  okJson,
  rateLimit,
  requireXlUser,
  verifiedWebAdmin,
  verifiedWebStaff,
  workError,
  WORK_SUBMIT_DOMAINS,
} from "@/lib/work/http";
import { notifyTransfer } from "@/lib/work/notify";
import { sameEmail, transferBlockedReason, transferTarget } from "@/lib/work/transfer";
import { statusView } from "@/lib/work/view";

type Ctx = { params: Promise<{ id: string }> };

const NOT_FOUND = () =>
  workError("not_found", "That submission does not exist.", 404);

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const user = await requireXlUser();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  // A per-MINUTE window. This is a single-row local write that ALSO sends up
  // to three emails, so it is not cost-free; what makes the minute window
  // right is that ownership itself bounds the loop. A non-admin can move
  // only rows they own and stops owning them on success, so their ceiling is
  // their own submission count, not the limiter. An admin can move any row
  // repeatedly, which is an admin capability (they can already send mail),
  // and a per-DAY bucket to bound it would be the exact shape of the
  // 2026-08-09 directory lockout: the shared limiter's window is fixed from
  // its first request, so a long window refuses for the rest of it. 10/min
  // matches the other one-shot verbs; reorder's 30/min is not the comparison,
  // since moving a row is a decision rather than a nudge.
  const limited = rateLimit(`work:transfer:${user.userId}`, 60, 10);
  if (limited) return limited;

  let raw: unknown;
  try {
    raw = ((await req.json()) as { email?: unknown }).email;
  } catch {
    return workError(
      "invalid_request",
      'Send JSON like {"email": "name@xl.net"}.',
      422
    );
  }

  const row = await submissionById(id);
  // ONE identical 404 for missing and not-yours, same discipline as the
  // [id] GET: a distinct 403 would turn this route into an oracle for
  // whether any given uuid exists. verifiedWebAdmin, not bare isAdmin,
  // because the Microsoft common-tenant lane can mint an isAdmin-passing
  // session (see the head of src/lib/rfp/access.ts).
  const isVerifiedAdmin = verifiedWebAdmin(user);
  if (!row || (!sameEmail(row.submitterEmail, user.email) && !isVerifiedAdmin))
    return NOT_FOUND();
  // The OWNER path is provider-checked too, which retry and the [id] GET are
  // not. The difference is the harm class: those are additive and leave the
  // legitimate owner holding the row, while this verb permanently strips
  // them, and requireXlUser's domain-only gate is forgeable through the
  // Microsoft common-tenant lane (src/lib/rfp/access.ts). Refused AFTER the
  // 404 so it stays no oracle: only someone who already owns the row, or an
  // admin, can see this message at all.
  if (!isVerifiedAdmin && !verifiedWebStaff(user))
    return workError(
      "untrusted_provider",
      "Moving a submission needs a sign-in that verified your address. Sign out and sign back in with your xl.net account, then try again; if it still says this, sign in with Google.",
      403
    );

  // The lane comes from the ROW. A public /work row may only move to an
  // xl.net address; a company row may only move inside that company's own
  // domain, or the move would be a cross-tenant write.
  let laneDomains: readonly string[] = WORK_SUBMIT_DOMAINS;
  let laneLabel = "the Our Work page";
  if (row.companyId !== null) {
    const company = await companyById(row.companyId);
    if (!company)
      return workError(
        "conflict",
        "This submission belongs to a company workspace that is no longer set up, so it cannot be moved.",
        409
      );
    // A paused workspace refuses its OWN members at requireWorkUser, so
    // reassigning inside it would move a row between two people who cannot
    // see it and then mail them both about it. Rejected alternative: allow
    // it on the argument that a move inside one tenant changes no exposure -
    // true, and beside the point, because the notification is the part that
    // becomes incoherent. Unpausing is the admin's lever.
    if (company.status !== "active")
      return workError(
        "conflict",
        "This submission's company workspace is paused, so its work cannot be moved right now.",
        409
      );
    const laneDomain = company.domain.trim().toLowerCase();
    // companyById reads the row straight out; companyForDomainRow is the
    // path that runs isCompanyEligibleDomain as defense in depth. This route
    // is the first consumer to use company.domain as a WRITE-AUTHORIZATION
    // predicate, so it re-runs that check: a row whose stored domain somehow
    // became a freemail or shared-tenant suffix must not become a licence to
    // hand a private card to gmail.com.
    if (!isCompanyEligibleDomain(laneDomain))
      return workError(
        "conflict",
        "This submission's company workspace has a domain that cannot receive work. Ask Adam to sort the workspace out first.",
        409
      );
    laneDomains = [laneDomain];
    laneLabel = `${company.name}'s private Your Work page`;
  }

  const target = transferTarget({
    raw,
    laneDomains,
    currentOwner: row.submitterEmail,
    laneLabel,
  });
  if (!target.ok) return workError(target.code, target.message, 422);

  // A live panel run addresses its outcome email to the row it read at claim
  // time, so moving underneath it would mail the result to the previous
  // owner and tell the new one nothing. A run whose heartbeat has gone stale
  // is not protected: an orphaned row must never be unmovable.
  const blocked = transferBlockedReason({
    status: row.status,
    stale: statusView(row).stale,
  });
  if (blocked) return workError("conflict", blocked, 409);

  const toUserId = await userIdForEmail(target.email);
  const res = await transferSubmission({
    id,
    toEmail: target.email,
    // Compare-and-swap against every fact this request was authorized on:
    // the owner (authorization) and the status plus run identity (the state
    // gate above). Without the last two the gate is advisory, because a
    // queue-drain tick between the read and the write can put the row into a
    // live run whose outcome email would then go to the previous owner.
    expectOwnerEmail: row.submitterEmail,
    expectStatus: row.status,
    expectAttemptId: row.panelAttemptId,
    toUserId,
  });
  if (!res.ok)
    return workError(
      "conflict",
      "This submission changed while you were moving it (a review may have just started, or someone else moved it). Reload and look again.",
      409
    );

  // No revalidatePath: the public card renders its credit from
  // submitter_name (src/components/work-card.tsx), which a transfer never
  // touches, so /work's HTML is byte-identical afterwards. The surfaces that
  // DO read submitter_email (the roadmap scorecard, /admin/work) are all
  // force-dynamic.
  // after(), not await: notifyTransfer can send THREE messages and each
  // Resend call carries a 20 s timeout, so awaiting them would hold the
  // confirmation behind up to a minute of mail. The write has already
  // committed, sendGovernanceEmail never throws and logs its own failures,
  // and this is a route handler with a live work unit (the POST route uses
  // after() the same way for kickPanel). NOT the pattern for the detached
  // email webhook, where after() callbacks never run at all.
  after(async () => {
    await notifyTransfer({
      row: res.row,
      previousEmail: res.previousEmail,
      actorEmail: user.email,
    });
  });
  console.log(
    `[work] transferred sub=${id} from=${res.previousEmail} to=${res.row.submitterEmail} by=${user.email}`
  );
  return okJson({ transferred: true, owner: res.row.submitterEmail });
}
