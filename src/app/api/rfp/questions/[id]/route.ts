// PATCH /api/rfp/questions/[id] — edit an intake question. ADMIN.
//
// Text and the required flag only: kind is the promotion switch (a choice
// must never become a fact by edit), and category/order are structural.
// Admin authorization lives in updateQuestion (throws on non-admin).

import { logRfpActivity } from "@/lib/rfp/activity";
import { updateQuestion } from "@/lib/rfp/db";
import { requireRfpApi, rfpError, rfpOk } from "@/lib/rfp/http";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const gate = await requireRfpApi("PATCH /api/rfp/questions/[id]");
  if (!gate.ok) return gate.response;
  const user = gate.user;
  if (!user.admin)
    return rfpError("forbidden", "Only an admin edits the questionnaire.", 403);

  const { id } = await params;
  let body: { text?: string; required?: boolean };
  try {
    body = await req.json();
  } catch {
    return rfpError("invalid_request", "Send JSON.", 400);
  }
  const text = String(body.text ?? "").trim();
  if (text.length < 5)
    return rfpError("invalid_request", "Write the question.", 400);

  const ok = await updateQuestion(user, id, {
    text,
    required: body.required === true,
  });
  if (!ok) return rfpError("not_found", "No such question.", 404);

  await logRfpActivity({
    actorEmail: user.email,
    actorAdmin: true,
    action: "question.edit",
    subjectKind: "fact",
    subjectId: id,
  });

  return rfpOk({ ok: true });
}
