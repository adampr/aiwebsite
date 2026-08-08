// POST - requester cancels their own still-pending request (§5.19): a hard
// DELETE, not a status (pending rows are private; there is nothing to
// audit). Approved rows are delisted by an admin reject instead.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { okJson, rateLimit, workError } from "@/lib/work/http";
import {
  isRequestId,
  requireRequestUser,
  transitionErrorResponse,
} from "@/lib/work/requests-http";
import { cancelRequest } from "@/lib/work/requests-db";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx): Promise<Response> {
  const user = await requireRequestUser();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  if (!isRequestId(id))
    return workError("not_found", "That request does not exist.", 404);
  const limited = rateLimit(`workreq:cancel:${user.userId}`, 60, 10);
  if (limited) return limited;

  const res = await cancelRequest(user.scope, id, user.email);
  if (!res.ok)
    return transitionErrorResponse(res, {
      verbPast: "cancelled",
      quotaMessage: "Too many changes at once. Give it a moment.",
    });
  return okJson({ status: "cancelled" });
}
