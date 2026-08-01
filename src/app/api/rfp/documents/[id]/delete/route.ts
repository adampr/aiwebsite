// POST /api/rfp/documents/[id]/delete — delete one RFP outright. ADMIN ONLY.
//
// The document row cascades to its requirements and proposals (schema FKs),
// taking the draft with it; knowledge proposals that referenced it survive
// with document_id nulled. Non-admins get 403 with an explanation (they are
// already inside the staff gate, so existence is not the secret here — the
// missing CAPABILITY is, and telling them to archive instead is the useful
// answer). Owners who just want it out of their list use archive.

import { logRfpActivity } from "@/lib/rfp/activity";
import { countKnowledgeForDocument, deleteDocument, getDocument } from "@/lib/rfp/db";
import { notFound, requireRfpApi, rfpError, rfpOk } from "@/lib/rfp/http";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const gate = await requireRfpApi("POST /api/rfp/documents/[id]/delete");
  if (!gate.ok) return gate.response;
  const user = gate.user;

  if (!user.admin)
    return rfpError(
      "forbidden",
      "Only an admin can delete an RFP. Archive it to move it out of your list.",
      403
    );

  const { id } = await params;
  const doc = await getDocument(user, id);
  if (!doc) return notFound();

  // Knowledge proposals survive the cascade with document_id nulled (they
  // are promotable company facts, not client material). Some carry
  // model-derived text from THIS RFP, so a delete run for a removal request
  // must record that the residue exists: after the cascade nothing links
  // them back to the document.
  const orphaned = await countKnowledgeForDocument(doc.id);

  const ok = await deleteDocument(user, doc.id);
  if (!ok) return notFound();

  await logRfpActivity({
    actorEmail: user.email,
    actorAdmin: true,
    action: "document.delete",
    subjectKind: "document",
    subjectId: doc.id,
    meta: { ownerEmail: doc.ownerEmail, knowledgeOrphaned: orphaned },
  });

  return rfpOk({ ok: true });
}
