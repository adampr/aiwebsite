// GET (status poll) / DELETE (withdraw or unpublish) - one submission
// (§5.16). Owner-or-admin; the not-found body is identical for missing and
// not-owned rows (no existence oracle).
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
  const { id } = await ctx.params;
  const limited = rateLimit(`work:delete:${user.userId}`, 60, 10);
  if (limited) return limited;
  const row = await submissionById(id);
  if (!row || (row.submitterEmail !== user.email && !user.admin))
    return NOT_FOUND();
  const wasPublished = row.status === "published";
  await deleteSubmission(id);
  if (wasPublished) {
    try {
      const { revalidatePath } = await import("next/cache");
      revalidatePath("/work");
    } catch {
      // ISR revalidate=300 is the floor
    }
    // Removals of public content are always visible to the owner.
    if (user.email !== adminRecipient())
      await sendTroyEmail({
        subject: `[aiwebsite] /work card removed: ${row.title}`,
        text: `${user.email} deleted the published team card "${row.title}" (${row.slug ?? "no slug"}). The page updates within 5 minutes.`,
      });
  }
  return okJson({ deleted: true });
}
