// Shared request-field validation for the roadmap portal (§5.18). Pure: no
// db, no session, no env.

import { ROADMAP_CAPS } from "@/lib/roadmap/config";

/** company_people.id is a uuid column, so a malformed id reaching Postgres
 * as a uuid cast throws 22P02 and the route 500s where the honest answer is
 * a 404. Same rule and same shape as src/lib/rfp/db.ts isUuid; spelled here
 * so the pure validator does not have to import a db module. */
export function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    v
  );
}

/** Bulk-remove body. De-duplicates, because `Remove 40 selected` must not be
 * able to spend 40 of the cap on 12 distinct people. `suppress` is REQUIRED
 * with no default: the single-row route may default it ON, but silently
 * blacklisting up to directoryBulkRemoveMax addresses from every future
 * import is not a default anyone should get by omission. */
export function parseRemoveIds(body: unknown):
  | { ok: true; ids: string[]; suppress: boolean }
  | { ok: false; code: string; message: string } {
  // `null` is valid JSON, so req.json() hands it straight through and the
  // first property read would throw a 500 out of a validation path.
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return {
      ok: false,
      code: "invalid_request",
      message: "Select the people to remove.",
    };
  const fields = body as Record<string, unknown>;
  if (typeof fields.suppress !== "boolean")
    return {
      ok: false,
      code: "invalid_request",
      message: "Say whether to keep these people out of future imports.",
    };
  const raw = Array.isArray(fields.ids) ? fields.ids : null;
  if (!raw || raw.length === 0)
    return {
      ok: false,
      code: "invalid_request",
      message: "Select the people to remove.",
    };
  // Length is checked BEFORE the per-id walk so a huge array is rejected
  // without scanning it.
  if (raw.length > ROADMAP_CAPS.directoryBulkRemoveMax)
    return {
      ok: false,
      code: "too_many",
      message: `Remove up to ${ROADMAP_CAPS.directoryBulkRemoveMax} people at a time.`,
    };
  const ids: string[] = [];
  for (const v of raw) {
    // The offending value is never echoed back.
    if (typeof v !== "string" || !isUuid(v))
      return {
        ok: false,
        code: "invalid_request",
        message: "Select the people to remove.",
      };
    if (!ids.includes(v)) ids.push(v);
  }
  return { ok: true, ids, suppress: fields.suppress };
}

export function parsePersonFields(bodyIn: unknown):
  | {
      ok: true;
      name: string;
      email: string | null;
      phone: string | null;
    }
  | { ok: false; message: string } {
  // `null` is valid JSON; see parseRemoveIds.
  if (typeof bodyIn !== "object" || bodyIn === null || Array.isArray(bodyIn))
    return { ok: false, message: "Give the person a name." };
  const body = bodyIn as Record<string, unknown>;
  const name =
    typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
  if (name.length < 2) return { ok: false, message: "Give the person a name." };
  const emailRaw =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (emailRaw && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw))
    return { ok: false, message: "That email address does not look right." };
  const phoneRaw =
    typeof body.phone === "string" ? body.phone.trim().slice(0, 40) : "";
  if (phoneRaw && !/^[0-9+()\-. ext]+$/i.test(phoneRaw))
    return { ok: false, message: "That phone number does not look right." };
  return {
    ok: true,
    name,
    email: emailRaw || null,
    phone: phoneRaw || null,
  };
}
