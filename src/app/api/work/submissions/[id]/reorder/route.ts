// POST - admin-only REORDER of a published card (§5.16): move it to a
// 1-based spot within its own lane (public /work "From the Team" or one
// company's /roadmap/work) and densely re-rank that lane. The lane is
// derived from the ROW alone — the body carries only {spot}, so there is
// no client-supplied scope to point across tenants. Non-destructive and
// instantly reversible, hence no email and no confirm ceremony.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { reorderPublishedCard, submissionById } from "@/lib/work/db";
import {
  okJson,
  rateLimit,
  requireXlUser,
  verifiedWebAdmin,
  workError,
} from "@/lib/work/http";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const user = await requireXlUser();
  if (user instanceof Response) return user;
  // Provider-checked (§5.18): bare isAdmin is forgeable via the Microsoft
  // common-tenant lane (src/lib/rfp/access.ts).
  if (!verifiedWebAdmin(user)) return workError("forbidden", "Admin only.", 403);
  const { id } = await ctx.params;
  // 30/min, not the one-shot verbs' 10: arranging an 8-card lane is ~7
  // sequential moves plus corrections.
  const limited = rateLimit(`work:reorder:${user.userId}`, 60, 30);
  if (limited) return limited;
  let spot: unknown;
  try {
    spot = ((await req.json()) as { spot?: unknown }).spot;
  } catch {
    return workError("invalid_request", "Send JSON like {\"spot\": 3}.", 422);
  }
  // Malformed input is the caller's error (422); an overshooting spot is
  // NOT — a publish/delete racing the click changes the lane size, and the
  // transaction clamps to the end, preserving the toward-the-end intent.
  if (typeof spot !== "number" || !Number.isInteger(spot) || spot < 1)
    return workError(
      "invalid_request",
      "spot must be an integer of 1 or more.",
      422
    );
  const row = await submissionById(id);
  if (!row)
    return workError("not_found", "That submission does not exist.", 404);
  const res = await reorderPublishedCard(id, spot);
  if (!res.ok)
    return workError(
      res.reason === "not_published" ? "invalid_request" : "conflict",
      "Only a published card can be moved. This row changed state since the page loaded; reload /admin/work and look again.",
      409
    );
  // Company pages are force-dynamic (§5.18): only the public lane flushes.
  if (res.companyId === null) {
    try {
      const { revalidatePath } = await import("next/cache");
      revalidatePath("/work");
    } catch {
      // ISR revalidate=300 is the floor
    }
  }
  return okJson({ spot: res.spot, laneSize: res.laneSize });
}
