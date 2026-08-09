// POST - re-kick the panel for a received/failed/stale submission (§5.16).
// Owner-or-admin; the per-submission daily runs cap and every admission
// guard apply exactly as on first kick.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { after } from "next/server";
import { HELD_NEXT_STEPS } from "@/lib/work/config";
import { submissionById } from "@/lib/work/db";
import {
  okJson,
  rateLimit,
  requireWorkUser,
  verifiedWebAdmin,
  workError,
} from "@/lib/work/http";
import { kickPanel } from "@/lib/work/panel";
import { sameEmail } from "@/lib/work/transfer";

type Ctx = { params: Promise<{ id: string }> };

// The reader just pressed the manual lever and was refused; each string
// promises only what the §5.16 queue drain actually does next. disabled and
// claim promise nothing automatic because nothing automatic happens there
// (the kill switch also stops the drain; the drain never lifts the per-row
// cap). FAILED rows get the pre-drain manual wording: the drain deliberately
// never re-runs a failed row, so a starts-automatically promise would strand
// the reader waiting on a retry that never comes (refutation MAJOR,
// 2026-08-05).
const QUEUED_COPY: Record<string, string> = {
  disabled: "Submissions are paused right now.",
  deploy:
    "A deploy is in progress. The queue resumes automatically when it finishes.",
  budget:
    "The review pipeline is at its daily limit. Your submission stays queued and runs automatically when capacity returns.",
  busy:
    "Another review is running. Yours stays queued and starts automatically when it finishes.",
  brain:
    "The review pipeline is briefly offline. Your submission stays queued and starts automatically once it is back.",
  claim:
    "This submission cannot be re-run right now (already running, finished, or at its daily retry limit).",
};

const FAILED_RETRY_COPY: Record<string, string> = {
  disabled: "Submissions are paused right now.",
  deploy: "A deploy is in progress. Retry in a few minutes.",
  budget: "The review pipeline is at its daily limit. Try again tomorrow.",
  busy: "Another review is running. Retry in a few minutes.",
  brain: "The review pipeline is briefly offline. Retry shortly.",
  claim:
    "This submission cannot be re-run right now (already running, finished, or at its daily retry limit).",
};

export async function POST(_req: Request, ctx: Ctx): Promise<Response> {
  // requireWorkUser (§5.18): company submitters may retry their own failed
  // rows exactly like staff; ownership rules below are unchanged.
  const user = await requireWorkUser();
  if (user instanceof Response) return user;
  const isVerifiedAdmin = verifiedWebAdmin(user);
  const { id } = await ctx.params;
  const limited = rateLimit(`work:retry:${user.userId}`, 60, 5);
  if (limited) return limited;
  const row = await submissionById(id);
  // sameEmail (§5.16 transfer round): a moved row stores a typed address, so
  // raw equality would 404 the new owner out of the lever they were just
  // handed.
  if (!row || (!sameEmail(row.submitterEmail, user.email) && !isVerifiedAdmin))
    return workError("not_found", "That submission does not exist.", 404);
  if (row.status === "published")
    return workError(
      "invalid_request",
      "This submission is already published.",
      409
    );
  // §5.16 updates: a passed update is the admin's queue, not a retry target.
  if (row.status === "pending_approval")
    return workError(
      "pending",
      "This update passed review and is waiting for Adam to approve the swap.",
      409
    );
  // Once held, ALWAYS held for submitter purposes: heldAt is never cleared,
  // so a failed admin re-run cannot reopen retry-until-the-critic-blinks.
  // The admin elevation is provider-checked (§5.18): bare isAdmin is
  // forgeable via the Microsoft common-tenant lane.
  if (!isVerifiedAdmin && (row.status === "held" || row.heldAt))
    return workError(
      "held",
      user.scope.companyId !== null
        ? "This submission is held for review. The XL.net team reviews held cards and will publish the draft, run the review again, or remove it."
        : `This submission is held for review. ${HELD_NEXT_STEPS}`,
      409
    );
  if (row.status === "held")
    return workError(
      "invalid_request",
      "Use the admin re-run action for held submissions.",
      409
    );
  const kicked = await kickPanel(id);
  if (kicked.run) {
    after(kicked.run);
    return okJson({ status: "running" });
  }
  const reason =
    kicked.outcome.status === "refused" ? kicked.outcome.reason : "claim";
  const copy = row.status === "failed" ? FAILED_RETRY_COPY : QUEUED_COPY;
  return workError("queued", copy[reason] ?? copy.claim, 409, {
    reason,
  });
}
