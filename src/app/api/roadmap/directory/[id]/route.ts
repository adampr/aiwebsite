// PATCH (edit) / DELETE (remove) - one directory person (§5.18 step 2).
// Two lanes, lane-scoped WHEREs: the caller's company (company-admin only)
// or the XL.net STAFF lane (staff-parity round: readStaffPage selects,
// requireGlobalAdmin authorizes, scope = NULL lane). Any edit flips source
// to 'manual' so re-imports never clobber it. DELETE with suppress (default
// ON for apollo rows in the UI) records the email's sha256 so future
// imports skip this person for good.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import {
  readStaffPage,
  requireCompanyAdmin,
  requireGlobalAdmin,
} from "@/lib/roadmap/access";
import {
  STAFF_DIRECTORY_SCOPE,
  removePerson,
  updatePerson,
  type DirectoryScope,
} from "@/lib/roadmap/db";
import { isUniqueViolation } from "@/lib/work/db";
import { ROADMAP_CAPS } from "@/lib/roadmap/config";
import {
  okJson,
  rateLimit,
  requireRoadmapWritesEnabled,
  roadmapError,
} from "@/lib/roadmap/http";
import { parsePersonFields } from "@/lib/roadmap/validate";

type Ctx = { params: Promise<{ id: string }> };

const NOT_FOUND = () =>
  roadmapError("not_found", "That person is not in the directory.", 404);

/** Lane selection + authorization + kill switch + per-user rate limit, one
 * implementation for both verbs so the two lanes cannot drift. Staff
 * writes require requireGlobalAdmin; a non-admin staffer gets its 403 and
 * never falls through to the company path. */
async function gateLane(): Promise<
  { ok: true; scope: DirectoryScope } | { ok: false; response: Response }
> {
  const staff = await readStaffPage();
  if (staff) {
    const admin = await requireGlobalAdmin();
    if (!admin.ok) return admin;
    const disabled = requireRoadmapWritesEnabled();
    if (disabled) return { ok: false, response: disabled };
    const limited = rateLimit(
      `roadmap:dir:${admin.userId}`,
      3600,
      ROADMAP_CAPS.directoryWritesPerUserPerHour
    );
    if (limited) return { ok: false, response: limited };
    return { ok: true, scope: STAFF_DIRECTORY_SCOPE };
  }
  const gate = await requireCompanyAdmin();
  if (!gate.ok) return gate;
  const p = gate.principal;
  const disabled = requireRoadmapWritesEnabled();
  if (disabled) return { ok: false, response: disabled };
  const limited = rateLimit(
    `roadmap:dir:${p.userId}`,
    3600,
    ROADMAP_CAPS.directoryWritesPerUserPerHour
  );
  if (limited) return { ok: false, response: limited };
  return { ok: true, scope: { companyId: p.company.id } };
}

export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  const lane = await gateLane();
  if (!lane.ok) return lane.response;
  const { id } = await ctx.params;
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
  const lane = await gateLane();
  if (!lane.ok) return lane.response;
  const { id } = await ctx.params;
  const suppress = new URL(req.url).searchParams.get("suppress") !== "0";
  const row = await removePerson({
    scope: lane.scope,
    personId: id,
    suppress,
  });
  if (!row) return NOT_FOUND();
  return okJson({ deleted: true, suppressed: suppress && !!row.email });
}
