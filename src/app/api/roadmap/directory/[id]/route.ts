// PATCH (edit) / DELETE (remove) - one directory person (§5.18 step 2).
// Both lanes and both verbs go through directoryWriteLane (the ONE gate:
// readStaffPage selects, requireGlobalAdmin / requireCompanyAdmin
// authorizes, requireRoadmapWritesEnabled is the kill switch, per-actor
// rate limit) and every db call takes the lane scope it returns, so the
// WHERE is always lane-filtered. Any edit flips source to 'manual' so
// re-imports never clobber it. DELETE with suppress (default ON for apollo
// rows in the UI) records the email's sha256 so future imports skip this
// person for good. Sweeps go to ../remove, not a loop over this route.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { removePerson, updatePerson } from "@/lib/roadmap/db";
import { directoryWriteLane } from "@/lib/roadmap/directory-gate";
import { isUniqueViolation } from "@/lib/work/db";
import { okJson, roadmapError } from "@/lib/roadmap/http";
import { isUuid, parsePersonFields } from "@/lib/roadmap/validate";

type Ctx = { params: Promise<{ id: string }> };

const NOT_FOUND = () =>
  roadmapError("not_found", "That person is not in the directory.", 404);

export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  const lane = await directoryWriteLane();
  if (!lane.ok) return lane.response;
  const { id } = await ctx.params;
  // A non-uuid would reach Postgres as a uuid cast and throw 22P02, i.e. a
  // 500 where the honest answer is "no such person".
  if (!isUuid(id)) return NOT_FOUND();
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return roadmapError("invalid_request", "Send JSON.", 400);
  }
  const fields = parsePersonFields(body);
  if (!fields.ok) return roadmapError("invalid_request", fields.message, 400);
  try {
    const row = await updatePerson({
      scope: lane.scope,
      personId: id,
      name: fields.name,
      email: fields.email,
      phone: fields.phone,
    });
    if (!row) return NOT_FOUND();
    return okJson({ updated: true });
  } catch (err) {
    if (
      isUniqueViolation(
        err,
        "company_people_email_uq",
        "company_people_email_staff_uq"
      )
    )
      return roadmapError(
        "duplicate_email",
        "Someone else in the directory already has that email.",
        409
      );
    throw err;
  }
}

export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  const lane = await directoryWriteLane();
  if (!lane.ok) return lane.response;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NOT_FOUND();
  const suppress = new URL(req.url).searchParams.get("suppress") !== "0";
  const row = await removePerson({
    scope: lane.scope,
    personId: id,
    suppress,
  });
  if (!row) return NOT_FOUND();
  return okJson({ deleted: true, suppressed: suppress && !!row.email });
}
