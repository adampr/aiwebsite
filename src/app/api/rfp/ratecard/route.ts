// PATCH /api/rfp/ratecard — edit a line or the minimums. ADMIN.
//
// Body: { code, label?, unitPriceCents?, unit?, note? }
//     | { minimumFullyManagedUsers, minimumMonthlyFeeCents }.
// Every field but the CODE is editable: the code is the identity the quote
// engine and rule B1 resolve lines by. Historical quotes are safe by
// design: unit prices and labels are SNAPSHOTTED into each quote at build
// time, so this changes what future quotes compute, never what a shown
// quote said. Label and note reach client documents, so the site's em-dash
// ban applies at the door. The activity log records WHICH line moved,
// never a figure (shape-only rule).

import { logRfpActivity } from "@/lib/rfp/activity";
import { updateRateCard } from "@/lib/rfp/db";
import { requireRfpApi, rfpError, rfpOk } from "@/lib/rfp/http";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function PATCH(req: Request): Promise<Response> {
  const gate = await requireRfpApi("PATCH /api/rfp/ratecard");
  if (!gate.ok) return gate.response;
  const user = gate.user;
  if (!user.admin)
    return rfpError("forbidden", "Only an admin edits the rate card.", 403);

  let body: {
    code?: string;
    label?: string;
    unitPriceCents?: number;
    unit?: string;
    note?: string | null;
    minimumFullyManagedUsers?: number;
    minimumMonthlyFeeCents?: number;
  };
  try {
    body = await req.json();
  } catch {
    return rfpError("invalid_request", "Send JSON.", 400);
  }

  if (typeof body.code === "string") {
    const patch: {
      kind: "item";
      code: string;
      label?: string;
      unitPriceCents?: number;
      unit?: string;
      note?: string | null;
    } = { kind: "item", code: body.code };

    if (body.unitPriceCents !== undefined) {
      const cents = Number(body.unitPriceCents);
      if (!Number.isFinite(cents) || cents < 0)
        return rfpError("invalid_request", "unitPriceCents must be >= 0.", 400);
      patch.unitPriceCents = cents;
    }
    if (body.label !== undefined) {
      const label = String(body.label).trim();
      if (label.length < 2)
        return rfpError("invalid_request", "Write the line's label.", 400);
      patch.label = label;
    }
    if (body.unit !== undefined) {
      const unit = String(body.unit).trim();
      if (!unit)
        return rfpError("invalid_request", "Write the unit (user/month, one-time, ...).", 400);
      patch.unit = unit;
    }
    if (body.note !== undefined)
      patch.note =
        body.note === null || String(body.note).trim() === ""
          ? null
          : String(body.note).trim();

    // Label and note land in client-facing documents; the site bans em
    // dashes in visible copy, and the gate cannot re-scan a rate card.
    for (const text of [patch.label, patch.note])
      if (typeof text === "string" && text.includes("—"))
        return rfpError(
          "invalid_request",
          "No em dashes in client-facing copy. Use a comma, a full stop, or a middot.",
          400
        );

    if (
      patch.label === undefined &&
      patch.unitPriceCents === undefined &&
      patch.unit === undefined &&
      patch.note === undefined
    )
      return rfpError("invalid_request", "Nothing to change.", 400);

    const ok = await updateRateCard(user, patch);
    if (!ok) return rfpError("not_found", "No such rate-card line.", 404);
    await logRfpActivity({
      actorEmail: user.email,
      actorAdmin: true,
      action: "ratecard.edit",
      subjectKind: "fact",
      subjectId: body.code,
    });
    return rfpOk({ ok: true });
  }

  const users = Number(body.minimumFullyManagedUsers);
  const floor = Number(body.minimumMonthlyFeeCents);
  if (!Number.isFinite(users) || !Number.isFinite(floor) || users < 0 || floor < 0)
    return rfpError("invalid_request", "Send the minimums as numbers.", 400);
  const ok = await updateRateCard(user, {
    kind: "minimums",
    minimumFullyManagedUsers: users,
    minimumMonthlyFeeCents: floor,
  });
  if (!ok) return rfpError("not_found", "No rate card is loaded.", 404);
  await logRfpActivity({
    actorEmail: user.email,
    actorAdmin: true,
    action: "ratecard.edit",
    subjectKind: "fact",
    subjectId: "minimums",
  });
  return rfpOk({ ok: true });
}
