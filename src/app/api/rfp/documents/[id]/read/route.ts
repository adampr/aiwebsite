// POST /api/rfp/documents/[id]/read — read a saved RFP again.
//
// For a document whose first read failed ("read_failed"), one still marked
// "reading" long after any reader could be alive (a restart or deploy
// dropped the background task), or one "extracted" with no section
// structure (§5.17.17: a read that left nothing to draft). The stored,
// already-screened text is read
// again through the same worker as the first read, so nothing has to be
// uploaded twice. Returns 202 and the caller polls .../status, exactly like
// the create route.
//
// The claim is ONE conditional UPDATE (db.ts claimReread): a second click, a
// second tab or a second person gets 409 instead of starting a parallel read.

import { after } from "next/server";
import { logRfpActivity } from "@/lib/rfp/activity";
import { claimReread, getDocument } from "@/lib/rfp/db";
import { notFound, requireRfpApi, rfpError, rfpOk } from "@/lib/rfp/http";
import { isAutoTitle } from "@/lib/rfp/doc-title";
import { runDocumentRead } from "@/lib/rfp/read-document";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const gate = await requireRfpApi("POST /api/rfp/documents/[id]/read");
  if (!gate.ok) return gate.response;
  const user = gate.user;

  const { id } = await params;
  const doc = await getDocument(user, id);
  if (!doc) return notFound();

  const row = await claimReread(doc.id);
  if (!row) {
    return doc.status === "extracted"
      ? rfpError("already_read", "This RFP has already been read.", 409)
      : rfpError("busy", "This RFP is being read now.", 409);
  }

  await logRfpActivity({
    actorEmail: user.email,
    actorAdmin: user.admin,
    action: "document.reread",
    subjectKind: "document",
    subjectId: doc.id,
    meta: { from: doc.status, chars: row.rawText.length },
  });

  after(() =>
    runDocumentRead({
      docId: doc.id,
      rawText: row.rawText,
      storedTitle: row.title,
      autoTitle: isAutoTitle(row.title, row.sourceName),
      sourceKind: row.sourceKind,
      actor: { email: user.email, admin: user.admin },
    })
  );

  return rfpOk({ id: doc.id, status: "reading" }, 202);
}
