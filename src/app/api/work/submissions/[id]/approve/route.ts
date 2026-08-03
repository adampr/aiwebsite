// POST - admin-only approve (§5.16). Two shapes:
// - ordinary held row: publishes the stored draft as-is (approveHeld).
// - UPDATE row (parent_id set, pending_approval or held): runs the
//   transactional swap (publishWithSupersede). The branch keys on parentId,
//   not on how the row got held, so a held update can never be published
//   standalone beside its live predecessor (refutation FATAL, 2026-08-03).
// This route is the ONLY code path that swaps an update live; it runs in a
// real request context, so revalidatePath works (the email path never can).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { approveHeld, publishWithSupersede, submissionById } from "@/lib/work/db";
import { okJson, rateLimit, requireXlUser, workError } from "@/lib/work/http";
import {
  deliverArchiveRetention,
  notifyUpdateApproved,
} from "@/lib/work/notify";
import { revalidateWorkPage } from "@/lib/work/panel";

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

  if (row.parentId) {
    const swapped = await publishWithSupersede(id);
    if (!swapped.ok) {
      if (swapped.reason === "conflict")
        return workError(
          "update_conflict",
          "The live card this update targeted is no longer published, so nothing was replaced. The update is now held; delete it, or submit the tool again as a new card if it should still be on /work.",
          409
        );
      return workError(
        "invalid_request",
        "Only a held submission or an update awaiting approval can be approved.",
        409
      );
    }
    try {
      const { revalidatePath } = await import("next/cache");
      revalidatePath("/work");
    } catch {
      // ISR revalidate=300 is the floor
    }
    await revalidateWorkPage();
    await notifyUpdateApproved(row, swapped.card, swapped.slug, {
      approverEmail: user.email,
      parent: swapped.parent,
    });
    // First time this update's original bytes leave the row.
    await deliverArchiveRetention(row);
    return okJson({ status: "published", slug: swapped.slug, updated: true });
  }

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
