// POST - lane-admin approve (§5.19): pending -> approved, onto the lane's
// board. Fence: UPDATE ... WHERE status='pending' AND lane; rowCount is the
// verdict.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { okJson, rateLimit, workError } from "@/lib/work/http";
import {
  isLaneAdmin,
  isRequestId,
  requireRequestUser,
  transitionErrorResponse,
} from "@/lib/work/requests-http";
import { approveRequest, requestById } from "@/lib/work/requests-db";
import { notifyRequestDecision } from "@/lib/work/requests-notify";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx): Promise<Response> {
  const user = await requireRequestUser();
  if (user instanceof Response) return user;
  if (!(await isLaneAdmin(user)))
    return workError("forbidden", "Admin only.", 403);
  const { id } = await ctx.params;
  if (!isRequestId(id))
    return workError("not_found", "That request does not exist.", 404);
  const limited = rateLimit(`workreq:approve:${user.userId}`, 60, 10);
  if (limited) return limited;

  const res = await approveRequest(user.scope, id, user.email);
  if (!res.ok)
    return transitionErrorResponse(res, {
      verbPast: "approved",
      quotaMessage: "Too many approvals at once. Give it a moment.",
    });
  const row = await requestById(user.scope, id);
  if (row) {
    await notifyRequestDecision({
      scope: user.scope,
      title: row.title,
      requesterEmail: row.requesterEmail,
      approved: true,
      reason: null,
    });
  }
  return okJson({ status: "approved" });
}
