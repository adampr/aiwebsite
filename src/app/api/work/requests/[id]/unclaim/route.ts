// POST - release a claim (§5.19): in_progress -> approved, developer fields
// cleared. The developer themselves, or a lane admin (freeing a slot someone
// abandoned). Once marked complete (done_pending) only admin send-back moves
// the row.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { okJson, rateLimit, workError } from "@/lib/work/http";
import {
  isLaneAdmin,
  isRequestId,
  requireRequestUser,
  transitionErrorResponse,
} from "@/lib/work/requests-http";
import { requestById, unclaimRequest } from "@/lib/work/requests-db";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx): Promise<Response> {
  const user = await requireRequestUser();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  if (!isRequestId(id))
    return workError("not_found", "That request does not exist.", 404);
  const limited = rateLimit(`workreq:unclaim:${user.userId}`, 60, 10);
  if (limited) return limited;

  // Self path first; the admin variant only when the caller is not the
  // developer (predicate re-derived per request, never from the client).
  const row = await requestById(user.scope, id);
  if (!row) return workError("not_found", "That request does not exist.", 404);
  const self =
    row.developerEmail !== null &&
    row.developerEmail.toLowerCase() === user.email.toLowerCase();
  if (!self && !(await isLaneAdmin(user)))
    return workError(
      "forbidden",
      "Only the person working on this project, or an admin, can unclaim it.",
      403
    );
  const res = await unclaimRequest(
    user.scope,
    id,
    self ? { selfEmail: user.email } : { admin: true }
  );
  if (!res.ok)
    return transitionErrorResponse(res, {
      verbPast: "unclaimed",
      quotaMessage: "Too many changes at once. Give it a moment.",
    });
  return okJson({ status: "approved" });
}
