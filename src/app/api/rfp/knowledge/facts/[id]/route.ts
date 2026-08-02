// POST /api/rfp/knowledge/facts/[id] — correct or retire one fact. ADMIN.
//
// Body: { action: "correct", statement, detail?, polarity?, category? }
//     | { action: "retire" }
//
// A correction INSERTS the fixed row at a new KB version and retires the
// wrong one (getFactById + correctFact in src/lib/rfp/db.ts). Never an
// UPDATE: rule C1's stale sweep, the corrected-facts page, and citations in
// older proposals all depend on the wrong version keeping its id.

import { logRfpActivity } from "@/lib/rfp/activity";
import { correctFact, getFactById, retireFact } from "@/lib/rfp/db";
import { requireRfpApi, rfpError, rfpOk } from "@/lib/rfp/http";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const gate = await requireRfpApi("POST /api/rfp/knowledge/facts/[id]");
  if (!gate.ok) return gate.response;
  const user = gate.user;
  if (!user.admin)
    return rfpError(
      "forbidden",
      "Only an admin edits the shared corpus. Propose the change from Knowledge instead.",
      403
    );

  const { id } = await params;
  const fact = await getFactById(id);
  if (!fact) return rfpError("not_found", "No such fact.", 404);

  let body: {
    action?: string;
    statement?: string;
    detail?: string;
    polarity?: string;
    category?: string;
  };
  try {
    body = await req.json();
  } catch {
    return rfpError("invalid_request", "Send JSON.", 400);
  }

  if (body.action === "retire") {
    const r = await retireFact(user, fact.id);
    if (!r.ok)
      return rfpError(
        "invalid_request",
        "That fact is already retired.",
        409
      );
    await logRfpActivity({
      actorEmail: user.email,
      actorAdmin: true,
      action: "knowledge.retire",
      subjectKind: "fact",
      subjectId: fact.id,
    });
    return rfpOk({ ok: true });
  }

  if (body.action === "correct") {
    const statement = String(body.statement ?? "").trim();
    if (statement.length < 5)
      return rfpError("invalid_request", "Write the corrected statement.", 400);
    const r = await correctFact(user, fact.id, {
      statement,
      detail: body.detail ? String(body.detail) : null,
      // Defaults to the OLD fact's polarity: an omitted field must not
      // silently flip a negative fact affirmative at confidence confirmed.
      polarity:
        body.polarity === "negative" || body.polarity === "affirmative"
          ? body.polarity
          : (fact.polarity as "affirmative" | "negative"),
      category: String(body.category ?? fact.category),
    });
    if (!r.ok)
      return rfpError(
        "invalid_request",
        "That fact is already retired; correct its replacement.",
        409
      );
    await logRfpActivity({
      actorEmail: user.email,
      actorAdmin: true,
      action: "knowledge.correct",
      subjectKind: "fact",
      subjectId: r.factId,
      meta: { supersedes: fact.id },
    });
    return rfpOk({ ok: true, factId: r.factId });
  }

  return rfpError("invalid_request", "action must be correct or retire.", 400);
}
