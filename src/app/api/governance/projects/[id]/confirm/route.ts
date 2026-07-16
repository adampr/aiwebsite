// POST — confirm the final draft (review -> done) (§5.12).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { governanceEnabled } from "@/lib/governance/config";
import { confirmProject } from "@/lib/governance/db";
import { govError, okJson, rateLimit, requireUser } from "@/lib/governance/http";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx): Promise<Response> {
  const user = await requireUser();
  if (user instanceof Response) return user;
  if (!governanceEnabled(process.env))
    return govError(
      "feature_disabled",
      "New drafting is paused right now. Existing projects and downloads still work.",
      503
    );
  const { id } = await ctx.params;
  const limited = rateLimit(`gov:confirm:${user.userId}`, 86_400, 10);
  if (limited) return limited;
  const ok = await confirmProject(user.userId, id);
  if (!ok)
    return govError(
      "invalid_request",
      "Only a draft in review can be confirmed.",
      409
    );
  return okJson({ status: "done" });
}
