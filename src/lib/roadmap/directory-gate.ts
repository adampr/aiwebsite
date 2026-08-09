// The ONE gate for every directory WRITE route (§5.18 step 2).
//
// Two lanes: the XL.net STAFF lane (company_id NULL) and the caller's own
// company. readStaffPage SELECTS the lane, requireGlobalAdmin AUTHORIZES the
// staff branch, requireCompanyAdmin authorizes the company branch, and
// requireRoadmapWritesEnabled (ROADMAP_ENABLED) is the staff lane's only
// write kill switch. A non-admin staffer gets the staff branch's 403 and
// never falls through to the company path.
//
// It lives here rather than in one of the route files because there are now
// THREE of them (POST add, PATCH/DELETE one person, POST bulk remove) and a
// per-file copy is how two lanes come to disagree about who may write. The
// scope this returns is the lane filter every db function requires, so a
// missed lane check stays a compile error.

import {
  readStaffPage,
  requireCompanyAdmin,
  requireGlobalAdmin,
} from "@/lib/roadmap/access";
import { STAFF_DIRECTORY_SCOPE, type DirectoryScope } from "@/lib/roadmap/db";
import { ROADMAP_CAPS } from "@/lib/roadmap/config";
import { rateLimit, requireRoadmapWritesEnabled } from "@/lib/roadmap/http";

export type DirectoryLane =
  | { ok: true; scope: DirectoryScope; userId: string }
  | { ok: false; response: Response };

/** Per-ACTOR limits, deliberately not per-verb and not per-tenant: the key
 * is about who is writing. `bulk` draws its own bucket because one call does
 * up to directoryBulkRemoveMax rows, and charging that to the single-write
 * bucket would lock the Add form out behind one sweep, which is the bug this
 * round exists to fix. Both windows are 60s: a directory write is one
 * statement against loopback Postgres (see the ROADMAP_CAPS comment). */
function writeLimit(userId: string, bulk: boolean): Response | null {
  const limited = bulk
    ? rateLimit(
        `roadmap:dirbulk:${userId}`,
        60,
        ROADMAP_CAPS.directoryBulkRemovesPerUserPerMinute
      )
    : rateLimit(
        `roadmap:dir:${userId}`,
        60,
        ROADMAP_CAPS.directoryWritesPerUserPerMinute
      );
  // Nothing recorded the refusal that produced the 2026-08-09 report, so
  // there was no way to tell "the admin is being throttled" from "the button
  // is broken" without reproducing it. One line, only when it actually
  // trips, so it can never become log noise.
  if (limited)
    console.warn(
      `[roadmap] directory write rate limited: user=${userId} lane=${bulk ? "bulk" : "single"}`
    );
  return limited;
}

export async function directoryWriteLane(
  opts: { bulk?: boolean } = {}
): Promise<DirectoryLane> {
  const bulk = opts.bulk === true;
  const staff = await readStaffPage();
  if (staff) {
    const admin = await requireGlobalAdmin();
    if (!admin.ok) return admin;
    const disabled = requireRoadmapWritesEnabled();
    if (disabled) return { ok: false, response: disabled };
    const limited = writeLimit(admin.userId, bulk);
    if (limited) return { ok: false, response: limited };
    return { ok: true, scope: STAFF_DIRECTORY_SCOPE, userId: admin.userId };
  }
  const gate = await requireCompanyAdmin();
  if (!gate.ok) return gate;
  const p = gate.principal;
  const disabled = requireRoadmapWritesEnabled();
  if (disabled) return { ok: false, response: disabled };
  const limited = writeLimit(p.userId, bulk);
  if (limited) return { ok: false, response: limited };
  return { ok: true, scope: { companyId: p.company.id }, userId: p.userId };
}
