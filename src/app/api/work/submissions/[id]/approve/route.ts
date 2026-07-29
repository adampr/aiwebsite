// POST - admin-only approve of a held card: publishes the stored draft
// as-is (§5.16). The section intro's wording covers this path ("holds
// anything it cannot verify for a human decision").
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { approveHeld, submissionById } from "@/lib/work/db";
import { okJson, rateLimit, requireXlUser, workError } from "@/lib/work/http";
import { deliverArchiveRetention } from "@/lib/work/notify";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx): Promise<Response> {
  const user = await requireXlUser();
  if (user instanceof Response) return user;
  if (!user.admin) return workError("forbidden", "Admin only.", 403);
  const { id } = await ctx.params;
  const limited = rateLimit(`work:approve:${user.userId}`, 60, 10);
  if (limited) return limited;
  const row = await submissionById(id);
  if (!row) return workError("not_found", "That submission does not exist.", 404);
  const slug = await approveHeld(id);
  if (!slug)
    return workError(
      "invalid_request",
      "Only a held submission with a stored draft can be approved.",
      409
    );
  try {
    const { revalidatePath } = await import("next/cache");
    revalidatePath("/work");
  } catch {
    // ISR revalidate=300 is the floor
  }
  // Owner retention email (original upload attachment) on this publish path
  // too; clears the stored bytes only on a confirmed send.
  await deliverArchiveRetention(row);
  return okJson({ status: "published", slug });
}
