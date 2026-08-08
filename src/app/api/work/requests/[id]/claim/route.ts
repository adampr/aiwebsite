// POST - claim an approved request (§5.19): approved -> in_progress. Any
// lane member; max REQUEST_CAPS.concurrentPerDeveloper concurrent claims
// (done_pending included), enforced inside the single fenced UPDATE.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { okJson, rateLimit, workError } from "@/lib/work/http";
import {
  isRequestId,
  requireRequestUser,
  transitionErrorResponse,
} from "@/lib/work/requests-http";
import { REQUEST_CAPS } from "@/lib/work/requests-config";
import { claimRequest } from "@/lib/work/requests-db";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx): Promise<Response> {
  const user = await requireRequestUser();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  if (!isRequestId(id))
    return workError("not_found", "That request does not exist.", 404);
  const limited = rateLimit(`workreq:claim:${user.userId}`, 60, 10);
  if (limited) return limited;

  const res = await claimRequest(user.scope, {
    id,
    userId: user.userId,
    email: user.email,
    name: null,
  });
  if (!res.ok)
    return transitionErrorResponse(res, {
      verbPast: "claimed",
      quotaMessage: `You are already working on ${REQUEST_CAPS.concurrentPerDeveloper} projects. Finish or unclaim one first.`,
    });
  return okJson({ status: "in_progress" });
}
