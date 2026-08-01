// POST /api/rfp/documents/[id]/archive — archive or restore one RFP.
//
// Body: { archived: boolean }. An owner archives their OWN; an admin can
// archive or restore anyone's. Archiving is presentation, not deletion: the
// row and its draft stay readable by id and admins see archived rows in
// their own subsection. Restoring is an admin action in practice, because an
// archived row is no longer in its owner's list to click. Someone else's id
// is 404, never 403, as everywhere in this section.

import { logRfpActivity } from "@/lib/rfp/activity";
import { getDocument, setDocumentArchived } from "@/lib/rfp/db";
import { notFound, requireRfpApi, rfpError, rfpOk } from "@/lib/rfp/http";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const gate = await requireRfpApi("POST /api/rfp/documents/[id]/archive");
  if (!gate.ok) return gate.response;
  const user = gate.user;

  const { id } = await params;
  const doc = await getDocument(user, id);
  if (!doc) return notFound();

  let body: { archived?: boolean };
  try {
    body = await req.json();
  } catch {
    return rfpError("invalid_request", "Send JSON.", 400);
  }
  const archived = body.archived === true;

  const ok = await setDocumentArchived(user, doc.id, archived);
  if (!ok) return notFound();

  await logRfpActivity({
    actorEmail: user.email,
    actorAdmin: user.admin,
    action: archived ? "document.archive" : "document.unarchive",
    subjectKind: "document",
    subjectId: doc.id,
  });

  return rfpOk({ ok: true, archived });
}
