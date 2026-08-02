// PATCH /api/rfp/ratecard — edit a line's unit price or the minimums. ADMIN.
//
// Body: { code, unitPriceCents } | { minimumFullyManagedUsers,
// minimumMonthlyFeeCents }. Historical quotes are safe by design: unit
// prices are SNAPSHOTTED into each quote at build time, so this changes
// what future quotes compute, never what a shown quote said. The activity
// log records WHICH line moved, never a figure (shape-only rule).

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
    unitPriceCents?: number;
    minimumFullyManagedUsers?: number;
    minimumMonthlyFeeCents?: number;
  };
  try {
    body = await req.json();
  } catch {
    return rfpError("invalid_request", "Send JSON.", 400);
  }

  if (typeof body.code === "string") {
    const cents = Number(body.unitPriceCents);
    if (!Number.isFinite(cents) || cents < 0)
      return rfpError("invalid_request", "unitPriceCents must be >= 0.", 400);
    const ok = await updateRateCard(user, {
      kind: "item",
      code: body.code,
      unitPriceCents: cents,
    });
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
