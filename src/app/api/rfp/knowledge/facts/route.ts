// POST /api/rfp/knowledge/facts — add a fact directly to the corpus. ADMIN.
//
// The user path stays proposals + review; this is the admin's direct lever,
// and it uses the same INSERT-at-a-new-KB-version mechanics as approval, so
// a directly-added fact is indistinguishable from an approved one.

import { logRfpActivity } from "@/lib/rfp/activity";
import { addFact } from "@/lib/rfp/db";
import { requireRfpApi, rfpError, rfpOk } from "@/lib/rfp/http";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(req: Request): Promise<Response> {
  const gate = await requireRfpApi("POST /api/rfp/knowledge/facts");
  if (!gate.ok) return gate.response;
  const user = gate.user;
  if (!user.admin)
    return rfpError(
      "forbidden",
      "Only an admin edits the shared corpus. Propose it from Knowledge instead.",
      403
    );

  let body: {
    key?: string;
    category?: string;
    statement?: string;
    detail?: string;
    polarity?: string;
  };
  try {
    body = await req.json();
  } catch {
    return rfpError("invalid_request", "Send JSON.", 400);
  }
  const statement = String(body.statement ?? "").trim();
  if (statement.length < 5)
    return rfpError("invalid_request", "Write the fact's statement.", 400);

  const result = await addFact(user, {
    key: String(body.key ?? ""),
    category: String(body.category ?? "capability"),
    statement,
    detail: body.detail ? String(body.detail) : null,
    polarity: body.polarity === "negative" ? "negative" : "affirmative",
  });
  if (!result.ok)
    return rfpError(
      "invalid_request",
      result.reason === "key_in_use"
        ? "A live fact already uses that key. Correct it instead of adding a twin."
        : "The key must be a slug like contract.term (letters, digits, dots, dashes).",
      400
    );

  await logRfpActivity({
    actorEmail: user.email,
    actorAdmin: true,
    action: "knowledge.add",
    subjectKind: "fact",
    subjectId: result.factId,
  });

  return rfpOk({ ok: true, factId: result.factId }, 201);
}
