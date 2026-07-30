// POST - ADMIN-ONLY re-run of a held submission (§5.16, 2026-07-30 panel).
// A fresh full panel under the current prompts: atomic held -> running claim
// (fromHeld), all gates apply, the stored draft is discarded in favor of the
// new run's synthesis. A refused admission leaves the row held, never in a
// submitter-retryable status.
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
    "This submission cannot be re-run right now (not held, or at its daily run limit).",
};

export async function POST(_req: Request, ctx: Ctx): Promise<Response> {
  const user = await requireXlUser();
  if (user instanceof Response) return user;
  if (!user.admin) return workError("forbidden", "Admin only.", 403);
  const { id } = await ctx.params;
  const limited = rateLimit(`work:rerun:${user.userId}`, 60, 10);
  if (limited) return limited;
  const row = await submissionById(id);
  if (!row) return workError("not_found", "That submission does not exist.", 404);
  if (row.status !== "held")
    return workError(
      "invalid_request",
      "Only a held submission can be re-run.",
      409
    );
  const kicked = await kickPanel(id, { fromHeld: true });
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
