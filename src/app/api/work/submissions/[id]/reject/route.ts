// POST - admin-only REJECT of a proposed update (§5.16 admin-mediated
// updates): deletes the proposal row and emails the submitter. The notified
// counterpart of a silent Delete; valid on pending_approval, or held rows
// that are updates. The live card is untouched, so no revalidation runs.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { deleteSubmission, submissionById } from "@/lib/work/db";
import { okJson, rateLimit, requireXlUser, workError } from "@/lib/work/http";
import { notifyUpdateRejected } from "@/lib/work/notify";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx): Promise<Response> {
  const user = await requireXlUser();
  if (user instanceof Response) return user;
  if (!user.admin) return workError("forbidden", "Admin only.", 403);
  const { id } = await ctx.params;
  const limited = rateLimit(`work:reject:${user.userId}`, 60, 10);
  if (limited) return limited;
  const row = await submissionById(id);
  if (!row)
    return workError("not_found", "That submission does not exist.", 404);
  const isRejectable =
    row.status === "pending_approval" ||
    (row.status === "held" && !!row.parentId);
  if (!isRejectable)
    return workError(
      "invalid_request",
      "Only a pending or held update can be rejected.",
      409
    );
  // Status-conditional: the auto-approve lane can publish this row between
  // our read and this delete, and hard-deleting a just-published child
  // strands its parent superseded with no rollback child.
  const deleted = await deleteSubmission(id, { expectStatus: row.status });
  if (!deleted)
    return workError(
      "conflict",
      "This update changed state since the page loaded (it may have just published). Reload /admin/work and look again.",
      409
    );
  await notifyUpdateRejected(row, user.email);
  return okJson({ rejected: true });
}
