// DELETE one stored upload file from the §5.16 archive store by ledger id
// (admin cleanup, owner directive 2026-08-19: uploads are retained in a
// storage area an admin can clean as needed). Calls deleteStoredArchive:
// the ledger row is stamped deleted_at/deleted_by FIRST, then the file is
// unlinked (a non-ENOENT unlink failure UN-STAMPS the row so the totals
// stay true and the admin retries); the row itself is never removed (audit
// trail). Deleting a file whose submission row still holds bytea is allowed
// by design: the row copy is independent, and the atomic verify-and-clear
// (verifyAndClearRowBytes) serializes behind the same ledger row locks, so
// it can never clear a row against a file this route already removed.
// ADMIN-ONLY behind verifiedWebAdmin (the same
// provider-checked predicate as every §5.16 admin verb; bare isAdmin is
// forgeable via the mv-less Microsoft common-tenant lane, see
// src/lib/rfp/access.ts), checked before the rate limit and the lookup so
// non-admins learn nothing about any id. Same-origin: /api/work is in
// proxy.ts protectedPrefixes, which covers this whole subtree.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { deleteStoredArchive } from "@/lib/work/archive-store";
import {
  okJson,
  rateLimit,
  requireWorkUser,
  verifiedWebAdmin,
  workError,
} from "@/lib/work/http";

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(_req: Request, ctx: Ctx): Promise<Response> {
  const user = await requireWorkUser();
  if (user instanceof Response) return user;
  if (!verifiedWebAdmin(user))
    return workError(
      "forbidden",
      "Only an admin can delete stored upload files.",
      403
    );
  const { id } = await ctx.params;
  // One-shot destructive verb, the work:delete sibling's window (60 s / 10).
  // The console's "Delete selected" runs sequentially and stops on the
  // first refusal, so a big sweep resumes after the named wait.
  const limited = rateLimit(`work:storage-delete:${user.userId}`, 60, 10);
  if (limited) return limited;
  const res = await deleteStoredArchive(id, user.email);
  if (!res.ok) {
    if (res.reason === "not a uuid" || res.reason === "not found or already deleted")
      return workError(
        "not_found",
        "That stored file does not exist or was already deleted.",
        404
      );
    // Unlink failed: deleteStoredArchive already un-stamped the ledger row
    // (or says why it could not), so the reason names the retry path.
    // Surface it verbatim.
    return workError("delete_failed", res.reason, 500);
  }
  console.log(
    `[work] archive store delete id=${id} rel=${res.row.relPath} bytes=${res.row.bytes} by=${user.email}`
  );
  return okJson({ deleted: true, bytes: res.row.bytes });
}
