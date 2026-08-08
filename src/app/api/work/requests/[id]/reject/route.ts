// POST - lane-admin reject (§5.19): pending -> rejected, and ALSO
// approved-but-unclaimed -> rejected (delist). The widening closes the
// 5-cap dead end (an approved row nobody claims would otherwise hold its
// requester's cap slot forever with no release transition). Body may carry
// an optional reason, quoted verbatim to the requester.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { okJson, rateLimit, workError } from "@/lib/work/http";
import {
  isLaneAdmin,
  isRequestId,
  requireRequestUser,
  transitionErrorResponse,
} from "@/lib/work/requests-http";
import { REQUEST_CAPS } from "@/lib/work/requests-config";
import { rejectRequest, requestById } from "@/lib/work/requests-db";
import { notifyRequestDecision } from "@/lib/work/requests-notify";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const user = await requireRequestUser();
  if (user instanceof Response) return user;
  if (!(await isLaneAdmin(user)))
    return workError("forbidden", "Admin only.", 403);
  const { id } = await ctx.params;
  if (!isRequestId(id))
    return workError("not_found", "That request does not exist.", 404);
  const limited = rateLimit(`workreq:reject:${user.userId}`, 60, 10);
  if (limited) return limited;

  let reason: string | null = null;
  try {
    const body = (await req.json()) as { reason?: unknown };
    if (typeof body.reason === "string") {
      const trimmed = body.reason.trim();
      if (trimmed.length > REQUEST_CAPS.rejectReasonMaxChars)
        return workError(
          "invalid_request",
          `Keep the reason under ${REQUEST_CAPS.rejectReasonMaxChars} characters.`,
          400
        );
      reason = trimmed.length > 0 ? trimmed : null;
    }
  } catch {
    // empty body is fine; reason is optional
  }

  const res = await rejectRequest(user.scope, id, user.email, reason);
  if (!res.ok)
    return transitionErrorResponse(res, {
      verbPast: "rejected",
      quotaMessage: "Too many decisions at once. Give it a moment.",
    });
  const row = await requestById(user.scope, id);
  if (row) {
    await notifyRequestDecision({
      scope: user.scope,
      title: row.title,
      requesterEmail: row.requesterEmail,
      approved: false,
      reason,
    });
  }
  return okJson({ status: "rejected" });
}
