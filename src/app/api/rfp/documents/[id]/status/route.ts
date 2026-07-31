// GET /api/rfp/documents/[id]/status — poll target while the RFP is read.

import { getDocument, listRequirements } from "@/lib/rfp/db";
import { notFound, requireRfpApi, rfpOk } from "@/lib/rfp/http";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const gate = await requireRfpApi("GET /api/rfp/documents/[id]/status");
  if (!gate.ok) return gate.response;

  const { id } = await params;
  const doc = await getDocument(gate.user, id);
  if (!doc) return notFound();

  const reqs = await listRequirements(doc.id);
  return rfpOk({
    id: doc.id,
    status: doc.status,
    clientName: doc.clientName,
    requirements: reqs.length,
    structure: doc.structureJson ? JSON.parse(doc.structureJson) : [],
    injectionFlagged: doc.injectionFlagged,
  });
}
