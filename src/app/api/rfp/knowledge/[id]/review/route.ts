// POST /api/rfp/knowledge/[id]/review — admin approves or returns proposed knowledge.
//
// Approval INSERTS a new fact at a new KB version rather than flipping a flag,
// so an approved fact's id has never been anything else. Returning is a status
// change on the proposal, which is why a rejection can never make an id vanish
// from someone else's live draft.

import { logRfpActivity } from "@/lib/rfp/activity";
import { approveKnowledge, returnKnowledge } from "@/lib/rfp/db";
import { requireRfpApi, rfpError, rfpOk } from "@/lib/rfp/http";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const gate = await requireRfpApi("POST /api/rfp/knowledge/[id]/review");
  if (!gate.ok) return gate.response;
  const user = gate.user;

  if (!user.admin)
    return rfpError(
      "forbidden",
      "Only an XL.net admin can decide on proposed knowledge.",
      403
    );

  const { id } = await params;
  let body: { action?: string; note?: string; confidence?: string };
  try {
    body = await req.json();
  } catch {
    return rfpError("invalid_request", "Send JSON.", 400);
  }

  if (body.action === "return") {
    const note = String(body.note ?? "").trim();
    if (note.length < 3)
      return rfpError(
        "invalid_request",
        "Say why it is going back, so it can be fixed.",
        400
      );
    const ok = await returnKnowledge(user, id, note);
    if (!ok) return rfpError("not_found", "No such proposal.", 404);
    await logRfpActivity({
      actorEmail: user.email,
      actorAdmin: true,
      action: "knowledge.return",
      subjectKind: "knowledge",
      subjectId: id,
    });
    return rfpOk({ ok: true, status: "returned" });
  }

  const confidence =
    body.confidence === "needs-adam" ? "needs-adam" : "confirmed";
  const result = await approveKnowledge(user, id, confidence);
  if (!result.ok) return rfpError("invalid_request", result.reason, 400);

  await logRfpActivity({
    actorEmail: user.email,
    actorAdmin: true,
    action: "knowledge.approve",
    subjectKind: "fact",
    subjectId: result.factId,
    meta: { proposalId: id, confidence },
  });

  return rfpOk({ ok: true, factId: result.factId });
}
