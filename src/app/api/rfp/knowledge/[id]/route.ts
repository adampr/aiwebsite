// /api/rfp/knowledge/[id] — the OWNER changes their own proposed knowledge
// (ARCHITECTURE.md §5.17.9). Owner-scoped through getMyKnowledgeProposal and
// the owner-predicated writers in src/lib/rfp/db.ts; someone else's id is a
// 404, never a 403.
//
//   PATCH  { kind?, factKey?, statement?, detail?, polarity?, category? }
//          edits the row IN PLACE (the id its pending_* citations use survives)
//   POST   { action: "submit" | "withdraw" | "promote", confidence? }
//          submit:   private | returned -> submitted
//          withdraw: submitted -> private
//          promote:  ADMIN, own row -> approved: mints the shared fact through
//                    approveKnowledge, the same INSERT-at-a-new-KB-version as
//                    the review queue, so a promoted fact is indistinguishable
//                    from an approved one
//   DELETE removes the row (never an approved one)
//
// All three refuse on status "approved": the minted shared fact is the truth
// then, and it is corrected or retired from the Shared tab (§5.17.2 round 5).

import { logRfpActivity } from "@/lib/rfp/activity";
import {
  approveKnowledge,
  deleteKnowledgeProposal,
  getMyKnowledgeProposal,
  setKnowledgeStatus,
  updateKnowledgeProposal,
} from "@/lib/rfp/db";
import { requireRfpApi, rfpError, rfpOk } from "@/lib/rfp/http";
import {
  canDeleteKnowledge,
  knowledgeTransition,
  normalizeKnowledgePatch,
  type KnowledgeAction,
} from "@/lib/rfp/knowledge-mine";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Ctx = { params: Promise<{ id: string }> };

const NOT_FOUND = () => rfpError("not_found", "No such knowledge.", 404);

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

export async function PATCH(req: Request, { params }: Ctx): Promise<Response> {
  const gate = await requireRfpApi("PATCH /api/rfp/knowledge/[id]");
  if (!gate.ok) return gate.response;
  const user = gate.user;
  const { id } = await params;

  const current = await getMyKnowledgeProposal(user, id);
  if (!current) return NOT_FOUND();
  if (current.status === "approved")
    return rfpError(
      "in_shared_base",
      "This one is in the shared base now. Correct it from the Shared tab.",
      409
    );

  const body = await readJson(req);
  if (!body) return rfpError("invalid_request", "Send JSON.", 400);

  const norm = normalizeKnowledgePatch(body, {
    kind: current.kind === "fact" ? "fact" : "choice",
    factKey: current.factKey,
    category: current.category,
    statement: current.statement,
    detail: current.detail,
    polarity: current.polarity === "negative" ? "negative" : "affirmative",
  });
  if (!norm.ok) return rfpError(norm.code, norm.message, norm.status);

  const row = await updateKnowledgeProposal(user, id, norm.fields);
  if (!row) return NOT_FOUND();

  await logRfpActivity({
    actorEmail: user.email,
    actorAdmin: user.admin,
    action: "knowledge.edit",
    subjectKind: "knowledge",
    subjectId: id,
    meta: {
      kind: row.kind,
      factKey: row.factKey,
      polarity: row.polarity,
      status: row.status,
      kindChanged: row.kind !== current.kind,
    },
  });

  return rfpOk({ id: row.id, status: row.status });
}

export async function POST(req: Request, { params }: Ctx): Promise<Response> {
  const gate = await requireRfpApi("POST /api/rfp/knowledge/[id]");
  if (!gate.ok) return gate.response;
  const user = gate.user;
  const { id } = await params;

  const current = await getMyKnowledgeProposal(user, id);
  if (!current) return NOT_FOUND();

  const body = await readJson(req);
  if (!body) return rfpError("invalid_request", "Send JSON.", 400);
  const action = String(body.action ?? "") as KnowledgeAction;

  const t = knowledgeTransition(current, action, user);
  if (!t.ok) return rfpError(t.code, t.message, t.status);

  if (t.to === "approved") {
    const confidence =
      body.confidence === "needs-adam" ? "needs-adam" : "confirmed";
    const result = await approveKnowledge(user, id, confidence);
    if (!result.ok)
      return rfpError(
        "invalid_request",
        result.reason === "not_awaiting_review"
          ? "That one changed under you. Reload and look again."
          : result.reason,
        409
      );
    await logRfpActivity({
      actorEmail: user.email,
      actorAdmin: true,
      action: "knowledge.promote",
      subjectKind: "fact",
      subjectId: result.factId,
      meta: { proposalId: id, confidence, from: current.status },
    });
    return rfpOk({ ok: true, status: "approved", factId: result.factId });
  }

  const moved = await setKnowledgeStatus(user, id, t.from, t.to);
  if (!moved)
    return rfpError(
      "invalid_request",
      "That one changed under you. Reload and look again.",
      409
    );
  await logRfpActivity({
    actorEmail: user.email,
    actorAdmin: user.admin,
    action: t.to === "submitted" ? "knowledge.submit" : "knowledge.withdraw",
    subjectKind: "knowledge",
    subjectId: id,
    meta: { kind: current.kind, factKey: current.factKey, from: current.status },
  });
  return rfpOk({ ok: true, status: t.to });
}

export async function DELETE(_req: Request, { params }: Ctx): Promise<Response> {
  const gate = await requireRfpApi("DELETE /api/rfp/knowledge/[id]");
  if (!gate.ok) return gate.response;
  const user = gate.user;
  const { id } = await params;

  const current = await getMyKnowledgeProposal(user, id);
  if (!current) return NOT_FOUND();
  const can = canDeleteKnowledge(current);
  if (can !== true) return rfpError(can.code, can.message, can.status);

  const gone = await deleteKnowledgeProposal(user, id);
  if (!gone)
    return rfpError(
      "invalid_request",
      "That one changed under you. Reload and look again.",
      409
    );
  await logRfpActivity({
    actorEmail: user.email,
    actorAdmin: user.admin,
    action: "knowledge.delete",
    subjectKind: "knowledge",
    subjectId: id,
    meta: { kind: current.kind, factKey: current.factKey, status: current.status },
  });
  return rfpOk({ ok: true });
}
