// POST - add a person to the directory (§5.18 step 2). Lane selection,
// authorization, kill switch and the per-USER write limit all come from the
// ONE gate, directoryWriteLane (the key is about the actor, not the tenant,
// and not the verb: add, edit and single remove share a bucket). Reads
// render server-side on the step page; this API carries only mutations.
// Exactly {name, email, phone} persists (privacy minimization).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { parsePersonFields } from "@/lib/roadmap/validate";
import { addPerson, type DirectoryScope } from "@/lib/roadmap/db";
import { directoryWriteLane } from "@/lib/roadmap/directory-gate";
import { isUniqueViolation } from "@/lib/work/db";
import { okJson, roadmapError } from "@/lib/roadmap/http";

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
  const lane = await directoryWriteLane();
  if (!lane.ok) return lane.response;
  return addToLane(req, lane.scope);
}
