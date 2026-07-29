// POST - re-kick the panel for a received/failed/stale submission (§5.16).
// Owner-or-admin; the per-submission daily runs cap and every admission
// guard apply exactly as on first kick.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { after } from "next/server";
import { submissionById } from "@/lib/work/db";
import { okJson, rateLimit, requireXlUser, workError } from "@/lib/work/http";
import { kickPanel } from "@/lib/work/panel";

type Ctx = { params: Promise<{ id: string }> };

const QUEUED_COPY: Record<string, string> = {
  disabled: "Submissions are paused right now.",
  deploy: "A deploy is in progress. Retry in a few minutes.",
  budget: "The review pipeline is at its daily limit. Try again tomorrow.",
  busy: "Another review is running. Retry in a few minutes.",
  brain: "The review pipeline is briefly offline. Retry shortly.",
  claim:
    "This submission cannot be re-run right now (already running, finished, or at its daily retry limit).",
};

export async function POST(_req: Request, ctx: Ctx): Promise<Response> {
  const user = await requireXlUser();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const limited = rateLimit(`work:retry:${user.userId}`, 60, 5);
  if (limited) return limited;
  const row = await submissionById(id);
  if (!row || (row.submitterEmail !== user.email && !user.admin))
    return workError("not_found", "That submission does not exist.", 404);
  if (row.status === "published" || row.status === "held")
    return workError(
      "invalid_request",
      row.status === "published"
        ? "This submission is already published."
        : "This submission is held for a human decision and cannot be re-run.",
      409
    );
  const kicked = await kickPanel(id);
  if (kicked.run) {
    after(kicked.run);
    return okJson({ status: "running" });
  }
  const reason =
    kicked.outcome.status === "refused" ? kicked.outcome.reason : "claim";
  return workError("queued", QUEUED_COPY[reason] ?? QUEUED_COPY.claim, 409, {
    reason,
  });
}
