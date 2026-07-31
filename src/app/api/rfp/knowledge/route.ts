// POST /api/rfp/knowledge — propose knowledge (private, or submitted for review).

import { logRfpActivity } from "@/lib/rfp/activity";
import { createKnowledgeProposal } from "@/lib/rfp/db";
import { requireRfpApi, rfpError, rfpOk } from "@/lib/rfp/http";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(req: Request): Promise<Response> {
  const gate = await requireRfpApi("POST /api/rfp/knowledge");
  if (!gate.ok) return gate.response;
  const user = gate.user;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return rfpError("invalid_request", "Send JSON.", 400);
  }

  const statement = String(body.statement ?? "").trim();
  if (statement.length < 10)
    return rfpError("invalid_request", "Write the fact out in full.", 400);

  const kind = body.kind === "fact" ? "fact" : "choice";
  const factKey = String(body.factKey ?? "").trim() || null;
  if (kind === "fact" && !factKey)
    return rfpError(
      "invalid_request",
      "A fact needs a key, for example contract.term.",
      400
    );

  const row = await createKnowledgeProposal(user, {
    kind,
    factKey,
    category: String(body.category ?? "general"),
    statement,
    detail: String(body.detail ?? "").trim() || null,
    polarity: body.polarity === "negative" ? "negative" : "affirmative",
    documentId: null,
    submit: body.submit === true,
  });

  await logRfpActivity({
    actorEmail: user.email,
    actorAdmin: user.admin,
    action: row.status === "submitted" ? "knowledge.submit" : "knowledge.propose",
    subjectKind: "knowledge",
    subjectId: row.id,
    meta: { kind, factKey, polarity: row.polarity },
  });

  return rfpOk({ id: row.id, status: row.status }, 201);
}
