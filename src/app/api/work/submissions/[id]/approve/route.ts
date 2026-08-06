// POST - admin-only approve (§5.16). Two shapes:
// - ordinary held row: publishes the stored draft as-is (approveHeld).
// - UPDATE row (parent_id set, pending_approval or held): runs the
//   transactional swap (publishWithSupersede). The branch keys on parentId,
//   not on how the row got held, so a held update can never be published
//   standalone beside its live predecessor (refutation FATAL, 2026-08-03).
// Two code paths swap an update live: this route (click authority, no
// attempt fence needed) and panel finishUpdateRow (the admin web
// auto-approve lane, fenced on its panel attempt). Because the auto lane
// publishes without a click, a stale /admin/work view can show Approve on a
// row that already swapped; that lands here as not_eligible and is answered
// honestly below instead of with the generic refusal.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { approveHeld, publishWithSupersede, submissionById } from "@/lib/work/db";
import {
  okJson,
  rateLimit,
  requireXlUser,
  verifiedWebAdmin,
  workError,
} from "@/lib/work/http";
import {
  deliverArchiveRetention,
  notifyUpdateApproved,
} from "@/lib/work/notify";
import { revalidateWorkPage } from "@/lib/work/panel";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx): Promise<Response> {
  const user = await requireXlUser();
  if (user instanceof Response) return user;
  // verifiedWebAdmin, not bare isAdmin (§5.18): approve now reaches
  // company-private rows, and a forged-Entra ADMIN_EMAIL session (nOAuth,
  // src/lib/rfp/access.ts) must not be able to publish anything. This also
  // closes the pre-existing staff-side hole on this route.
  if (!verifiedWebAdmin(user)) return workError("forbidden", "Admin only.", 403);
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
      // The auto-approve lane makes "clicked Approve on an already-swapped
      // row" a normal event (stale admin page); report what actually
      // happened instead of a refusal that reads like a failure.
      const now = await submissionById(id);
      if (now?.parentId && now.status === "published" && now.slug) {
        // Crash-recovery sweep-up: if the auto lane died between its swap
        // and the retention email, this re-sends it. Bytes stay on the row
        // permanently (2026-08-04), so a re-approve of an already-swapped
        // row sends the owner a duplicate retention email; accepted.
        await deliverArchiveRetention(now);
        return okJson({
          status: "published",
          slug: now.slug,
          updated: true,
          alreadySwapped: true,
        });
      }
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
  // Company pages are force-dynamic (§5.18): only the public lane flushes.
  if (row.companyId === null) {
    try {
      const { revalidatePath } = await import("next/cache");
      revalidatePath("/work");
    } catch {
      // ISR revalidate=300 is the floor
    }
  }
  // Owner retention email (original upload attachment) on this publish path
  // too; the stored bytes stay on the row permanently (2026-08-04).
  await deliverArchiveRetention(row);
  return okJson({ status: "published", slug });
}
