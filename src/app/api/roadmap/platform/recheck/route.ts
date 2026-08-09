// POST - the Retry button (§5.20). Re-runs the reachability check for one
// row, forcing it regardless of the field's current state.
//
// WHY RETRY EXISTS AS ITS OWN ROUTE: the owner's rule is that a URL we
// cannot reach is saved and simply does not count "until a successful test
// can pass (user can click Edit or Retry)". Edit goes through the save
// routes, which reset and re-check the changed field. Retry is the other
// half: the address is right, their server was having a bad minute, and
// nothing needs re-typing. It is the only path that re-checks a field
// already recorded as ok or failed, which is why it carries the tighter
// url-check limiter rather than the write limiter.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { listRoadmapLinks } from "@/lib/roadmap/db";
import {
  limitUrlCheck,
  requirePlatformAdmin,
} from "@/lib/roadmap/platform-http";
import {
  publicRow,
  verifyRow,
  type CheckField,
} from "@/lib/roadmap/platform-check";
import { okJson, roadmapError } from "@/lib/roadmap/http";
import { isUuid } from "@/lib/roadmap/validate";

function parseField(v: unknown): CheckField[] | null {
  if (v === undefined || v === null) return ["url", "docs"];
  if (v === "url") return ["url"];
  if (v === "docs") return ["docs"];
  return null;
}

export async function POST(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const { actor } = gate;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return roadmapError("invalid_request", "Send JSON.", 400);
  }
  const id = typeof body.id === "string" ? body.id : "";
  if (!id || !isUuid(id))
    return roadmapError("invalid_request", "Which one?", 400);
  const fields = parseField(body.field);
  if (!fields) return roadmapError("invalid_request", "Unknown field.", 400);

  // Lane-bound read: a row id from another tenant simply is not in this
  // list, so it reads as not_found without a separate ownership check.
  const rows = await listRoadmapLinks(actor.scope);
  const row = rows.find((r) => r.id === id);
  if (!row) return roadmapError("not_found", "That entry is not here.", 404);

  // The limiter is spent PER FIELD, exactly as on the save routes, so a
  // Retry cannot buy two probes with one token. Unlike a save, though, a
  // refusal HERE is a real refusal: the user pressed a button that does
  // exactly one thing, so if nothing got probed we say "not now" rather
  // than returning an unchanged row that looks like the check simply
  // found nothing to do.
  let refusal: Response | null = null;
  const fresh = await verifyRow(actor.scope, row, {
    force: true,
    fields,
    spend: () => {
      const r = limitUrlCheck(actor);
      if (r && !refusal) refusal = r;
      return r;
    },
  }).catch(() => ({ row, skipped: false, checked: [] as CheckField[] }));
  if (refusal && fresh.checked.length === 0) return refusal;
  return okJson({ row: publicRow(fresh.row) });
}
