// POST - developer marks their project complete (§5.19): in_progress ->
// done_pending. Developer ONLY (completion is the developer's claim; even an
// admin cannot make it for them). It counts as completed only after an
// admin validates.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { okJson, rateLimit, workError } from "@/lib/work/http";
import {
  isRequestId,
  requireRequestUser,
  transitionErrorResponse,
} from "@/lib/work/requests-http";
import { completeRequest, requestById } from "@/lib/work/requests-db";
import { notifyRequestCompleted } from "@/lib/work/requests-notify";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx): Promise<Response> {
  const user = await requireRequestUser();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  if (!isRequestId(id))
    return workError("not_found", "That request does not exist.", 404);
  const limited = rateLimit(`workreq:complete:${user.userId}`, 60, 10);
  if (limited) return limited;

  const res = await completeRequest(user.scope, id, user.email);
  if (!res.ok)
    return transitionErrorResponse(res, {
      verbPast: "marked complete",
      quotaMessage: "Too many changes at once. Give it a moment.",
    });
  const row = await requestById(user.scope, id);
  if (row) {
    await notifyRequestCompleted({
      scope: user.scope,
      title: row.title,
      developerEmail: user.email.toLowerCase(),
    });
  }
  return okJson({ status: "done_pending" });
}
