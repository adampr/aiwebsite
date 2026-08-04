// POST - add a person to the company directory (§5.18 step 2, company-admin
// only). Reads render server-side on the step page; this API carries only
// mutations. Exactly {name, email, phone} persists (privacy minimization).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { requireCompanyAdmin } from "@/lib/roadmap/access";
import { parsePersonFields } from "@/lib/roadmap/validate";
import { addPerson } from "@/lib/roadmap/db";
import { isUniqueViolation } from "@/lib/work/db";
import { ROADMAP_CAPS } from "@/lib/roadmap/config";
import {
  okJson,
  rateLimit,
  requireRoadmapWritesEnabled,
  roadmapError,
} from "@/lib/roadmap/http";

export async function POST(req: Request): Promise<Response> {
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
      companyId: p.company.id,
      name: fields.name,
      email: fields.email,
      phone: fields.phone,
    });
    return okJson({ id: row.id }, 201);
  } catch (err) {
    if (isUniqueViolation(err, "company_people_email_uq"))
      return roadmapError(
        "duplicate_email",
        "Someone with that email is already in the directory.",
        409
      );
    throw err;
  }
}
