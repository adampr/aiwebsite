// POST - rung 3 of the evidence ladder (§5.20 round 2): a named admin
// asserts that an address their builders use is real, after a genuine check
// could not reach it.
//
// WHY THIS EXISTS: the reachability check asks "can XL.net reach this?" as a
// stand-in for "can your builders reach this?". Those are the same question
// for a public URL and unrelated for one on the company's own network. A
// company that keeps its AI proxy off the public internet, which is the
// better posture, could otherwise never complete a step called Secure AI
// Builders, and a VPN-only wiki could never carry the instructions.
//
// WHY IT IS NOT A BYPASS, and this is the part to keep true:
//  - a real check must have RUN and FAILED first, in one of the two ways
//    consistent with an endpoint we cannot see from here (fieldAttestable).
//    A 404 is never attestable: the server answered and said the address is
//    wrong, so it needs correcting, not asserting.
//  - it is admin-only in both lanes, behind the same gate as every other
//    write (kill switch and suspended-company check included).
//  - it records WHO, and every surface shows the name. Attribution is the
//    control: a named person's claim on the record, visible to their
//    colleagues and to XL.net, not an anonymous checkbox.
//  - it is bound to the exact URL it describes, so editing the address
//    drops the attestation with it.
//  - it can be withdrawn, which returns the field to unchecked so the
//    ordinary check runs again.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { listRoadmapLinks, recordLinkCheck } from "@/lib/roadmap/db";
import { fieldAttestable } from "@/lib/roadmap/platform";
import {
  limitPlatformWrite,
  requirePlatformAdmin,
} from "@/lib/roadmap/platform-http";
import { publicRow, type CheckField } from "@/lib/roadmap/platform-check";
import { okJson, roadmapError } from "@/lib/roadmap/http";
import { isUuid } from "@/lib/roadmap/validate";

function parseField(v: unknown): CheckField | null {
  return v === "url" || v === "docs" ? v : null;
}

export async function POST(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const { actor } = gate;

  const limited = limitPlatformWrite(actor);
  if (limited) return limited;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return roadmapError("invalid_request", "Send JSON.", 400);
  }
  const id = typeof body.id === "string" ? body.id : "";
  if (!id || !isUuid(id))
    return roadmapError("invalid_request", "Which one?", 400);
  const field = parseField(body.field);
  if (!field) return roadmapError("invalid_request", "Unknown field.", 400);
  const withdraw = body.withdraw === true;

  // Lane-bound read: a row id from another tenant is simply not in this
  // list, so it reads as not_found without a separate ownership check.
  const rows = await listRoadmapLinks(actor.scope);
  const row = rows.find((r) => r.id === id);
  if (!row) return roadmapError("not_found", "That entry is not here.", 404);

  const value = field === "url" ? row.url : row.docsUrl;
  if (!value)
    return roadmapError("invalid_request", "There is no address here.", 400);

  const state = field === "url" ? row.urlState : row.docsState;

  if (withdraw) {
    if (state !== "attested")
      return roadmapError("invalid_request", "That is not attested.", 400);
    // Back to unchecked rather than failed: withdrawing is not a verdict,
    // and the field should be re-checked normally from here.
    const cleared = await recordLinkCheck({
      scope: actor.scope,
      id: row.id,
      field,
      probedUrl: value,
      state: "unchecked",
      reason: null,
      httpStatus: null,
    });
    if (!cleared) return roadmapError("conflict", "That address changed.", 409);
    return okJson({ row: publicRow(cleared, actor.internalDomain) });
  }

  const reason = field === "url" ? row.urlReason : row.docsReason;
  if (!fieldAttestable(state, reason, value, actor.internalDomain))
    return roadmapError(
      "not_attestable",
      "This one cannot be confirmed by hand. Either a server answered and the address is wrong, or the address is not inside your own domain, and only addresses on your domain can be confirmed as internal.",
      409
    );

  const fresh = await recordLinkCheck({
    scope: actor.scope,
    id: row.id,
    field,
    // Bound to the exact address being attested: if it was edited while this
    // request was in flight, the attestation lands on nothing.
    probedUrl: value,
    state: "attested",
    reason: null,
    httpStatus: null,
    attestedBy: actor.email,
  });
  if (!fresh)
    return roadmapError("conflict", "That address changed. Check it again.", 409);
  return okJson({ row: publicRow(fresh, actor.internalDomain) });
}
