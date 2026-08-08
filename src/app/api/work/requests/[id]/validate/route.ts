// POST - lane-admin validate (§5.19): done_pending -> completed. This is
// the ONLY transition that makes a completion official (owner requirement:
// a developer's own mark is never final). Developer fields are retained for
// scorecard attribution.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { okJson, rateLimit, workError } from "@/lib/work/http";
import {
  isLaneAdmin,
  isRequestId,
  requireRequestUser,
  transitionErrorResponse,
} from "@/lib/work/requests-http";
import { requestById, validateRequest } from "@/lib/work/requests-db";
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
  const limited = rateLimit(`workreq:validate:${user.userId}`, 60, 10);
  if (limited) return limited;

  const res = await validateRequest(user.scope, id, user.email);
  if (!res.ok)
    return transitionErrorResponse(res, {
      verbPast: "validated",
      quotaMessage: "Too many decisions at once. Give it a moment.",
    });
  const row = await requestById(user.scope, id);
  if (row?.developerEmail) {
    await notifyRequestValidated({
      scope: user.scope,
      title: row.title,
      developerEmail: row.developerEmail,
      validated: true,
    });
  }
  return okJson({ status: "completed" });
}
