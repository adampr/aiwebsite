// POST - lane-admin send-back (§5.19): done_pending -> in_progress (the
// completion claim did not hold up). The row stays the developer's; their
// 3-cap holding is unchanged, which is why done_pending counts toward the
// cap (this transition must never be refusable).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { okJson, rateLimit, workError } from "@/lib/work/http";
import {
  isLaneAdmin,
  isRequestId,
  requireRequestUser,
  transitionErrorResponse,
} from "@/lib/work/requests-http";
import { requestById, sendBackRequest } from "@/lib/work/requests-db";
import { notifyRequestValidated } from "@/lib/work/requests-notify";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx): Promise<Response> {
  const user = await requireRequestUser();
  if (user instanceof Response) return user;
  if (!(await isLaneAdmin(user)))
    return workError("forbidden", "Admin only.", 403);
  const { id } = await ctx.params;
  if (!isRequestId(id))
    return workError("not_found", "That request does not exist.", 404);
  const limited = rateLimit(`workreq:sendback:${user.userId}`, 60, 10);
  if (limited) return limited;

  const res = await sendBackRequest(user.scope, id);
  if (!res.ok)
    return transitionErrorResponse(res, {
      verbPast: "sent back",
      quotaMessage: "Too many decisions at once. Give it a moment.",
    });
  const row = await requestById(user.scope, id);
  if (row?.developerEmail) {
    await notifyRequestValidated({
      scope: user.scope,
      title: row.title,
      developerEmail: row.developerEmail,
      validated: false,
    });
  }
  return okJson({ status: "in_progress" });
}
