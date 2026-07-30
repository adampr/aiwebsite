// GET (status poll) / DELETE (remove or unpublish) - one submission
// (§5.16). GET is owner-or-admin with an identical not-found body for
// missing and not-owned rows (no existence oracle). DELETE is ADMIN-ONLY
// (owner directive 2026-07-30): checked before the rate limit and the DB
// lookup, so non-admins learn nothing about any id.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { adminRecipient, sendTroyEmail } from "@/lib/governance/budget";
import { deleteSubmission, submissionById } from "@/lib/work/db";
import { okJson, rateLimit, requireXlUser, workError } from "@/lib/work/http";
import { statusView } from "@/lib/work/view";

type Ctx = { params: Promise<{ id: string }> };

const NOT_FOUND = () =>
  workError("not_found", "That submission does not exist.", 404);

export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const user = await requireXlUser();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const limited = rateLimit(`work:poll:${user.userId}`, 60, 30);
  if (limited) return limited;
  const row = await submissionById(id);
  if (!row || (row.submitterEmail !== user.email && !user.admin))
    return NOT_FOUND();
  return okJson({ submission: statusView(row) });
}

export async function DELETE(_req: Request, ctx: Ctx): Promise<Response> {
  const user = await requireXlUser();
  if (user instanceof Response) return user;
  if (!user.admin)
    return workError(
      "forbidden",
      "Only an admin can remove a submission. Ask Adam to remove it for you.",
      403
    );
  const { id } = await ctx.params;
  const limited = rateLimit(`work:delete:${user.userId}`, 60, 10);
  if (limited) return limited;
  const row = await submissionById(id);
  if (!row) return NOT_FOUND();
  const wasPublished = row.status === "published";
  await deleteSubmission(id);
  if (wasPublished) {
    try {
      const { revalidatePath } = await import("next/cache");
      revalidatePath("/work");
    } catch {
      // ISR revalidate=300 is the floor
    }
    // Removals of public content are visible to the owner: reachable when
    // ADMIN_EMAIL holds more than one entry (adminRecipient() is the first),
    // so deletes by any other admin still notify. Not dead code.
    if (user.email !== adminRecipient())
      await sendTroyEmail({
        subject: `[aiwebsite] /work card removed: ${row.title}`,
        text: `${user.email} deleted the published team card "${row.title}" (${row.slug ?? "no slug"}). The page updates within 5 minutes.`,
      });
  }
  return okJson({ deleted: true });
}
