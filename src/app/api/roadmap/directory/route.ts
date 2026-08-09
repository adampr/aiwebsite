// POST - add a person to the directory (§5.18 step 2). Two lanes: the
// caller's company (company-admin only) or the XL.net STAFF lane
// (staff-parity round: readStaffPage selects, requireGlobalAdmin
// authorizes, scope = NULL lane). Reads render server-side on the step
// page; this API carries only mutations. Exactly {name, email, phone}
// persists (privacy minimization). The write rate limit stays per-USER in
// both lanes (the key is about the actor, not the tenant).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import {
  readStaffPage,
  requireCompanyAdmin,
  requireGlobalAdmin,
} from "@/lib/roadmap/access";
import { parsePersonFields } from "@/lib/roadmap/validate";
import {
  STAFF_DIRECTORY_SCOPE,
  addPerson,
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

/** Shared lane body so the two lanes cannot drift. Both partial-unique
 * names must be recognized: the company lane raises company_people_email_uq,
 * the staff (NULL) lane raises company_people_email_staff_uq. */
async function addToLane(req: Request, scope: DirectoryScope): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return roadmapError("invalid_request", "Send JSON.", 400);
  }
  const fields = parsePersonFields(body);
  if (!fields.ok) return roadmapError("invalid_request", fields.message, 400);
  try {
    const row = await addPerson({
      scope,
      name: fields.name,
      email: fields.email,
      phone: fields.phone,
    });
    return okJson({ id: row.id }, 201);
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
        "Someone with that email is already in the directory.",
        409
      );
    throw err;
  }
}

export async function POST(req: Request): Promise<Response> {
  const staff = await readStaffPage();
  if (staff) {
    const admin = await requireGlobalAdmin();
    if (!admin.ok) return admin.response;
    const disabled = requireRoadmapWritesEnabled();
    if (disabled) return disabled;
    const limited = rateLimit(
      `roadmap:dir:${admin.userId}`,
      3600,
      ROADMAP_CAPS.directoryWritesPerUserPerHour
    );
    if (limited) return limited;
    return addToLane(req, STAFF_DIRECTORY_SCOPE);
  }

  const gate = await requireCompanyAdmin();
  if (!gate.ok) return gate.response;
  const p = gate.principal;
  const disabled = requireRoadmapWritesEnabled();
  if (disabled) return disabled;
  const limited = rateLimit(
    `roadmap:dir:${p.userId}`,
    3600,
    ROADMAP_CAPS.directoryWritesPerUserPerHour
  );
  if (limited) return limited;
  return addToLane(req, { companyId: p.company.id });
}
