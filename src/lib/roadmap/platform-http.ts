// Shared route plumbing for phases 09/10/11 (§5.20).
//
// ONE gate for all four platform routes, because the two lanes and their
// three guards (select, authorize, kill switch) are exactly the thing that
// drifts when each route re-implements them. The staff branch follows the
// standing rule from the staff-parity round: readStaffPage SELECTS the
// lane, requireGlobalAdmin AUTHORIZES the write, and ROADMAP_ENABLED is
// the staff lane's only kill switch (there is no company_paused analogue
// because there is no companies row).

import {
  readStaffPage,
  requireCompanyAdmin,
  requireGlobalAdmin,
} from "@/lib/roadmap/access";
import { STAFF_LINK_SCOPE, type LinkScope } from "@/lib/roadmap/db";
import { ROADMAP_CAPS } from "@/lib/roadmap/config";
import {
  rateLimit,
  requireRoadmapWritesEnabled,
  roadmapError,
} from "@/lib/roadmap/http";

export type PlatformActor = {
  scope: LinkScope;
  userId: string;
  email: string;
  /** Rate-limit key fragment for per-tenant ceilings. The staff lane is a
   * literal, matching how the Apollo limiter keys it: the staff lane has no
   * company id, and inventing one would fork the fence. */
  laneKey: string;
};

export type PlatformGate =
  | { ok: true; actor: PlatformActor }
  | { ok: false; response: Response };

/** Admin-only in BOTH lanes, plus the write kill switch. Reads never come
 * through here: step pages render server-side from the principal. */
export async function requirePlatformAdmin(): Promise<PlatformGate> {
  const staff = await readStaffPage();
  if (staff) {
    const admin = await requireGlobalAdmin();
    if (!admin.ok) return { ok: false, response: admin.response };
    const disabled = requireRoadmapWritesEnabled();
    if (disabled) return { ok: false, response: disabled };
    return {
      ok: true,
      actor: {
        scope: STAFF_LINK_SCOPE,
        userId: admin.userId,
        email: admin.email,
        laneKey: "staff",
      },
    };
  }

  const gate = await requireCompanyAdmin();
  if (!gate.ok) return { ok: false, response: gate.response };
  const disabled = requireRoadmapWritesEnabled();
  if (disabled) return { ok: false, response: disabled };
  const p = gate.principal;
  // A SUSPENDED company keeps its reads and loses this. The house rule is
  // that the guards check membership and a route enforces status when it
  // has a reason to; apollo-import's reason is that it pulls PII, and this
  // one's is stronger: every save makes OUR server fetch an address the
  // company chose. Suspension is an XL.net response to something going
  // wrong, and "can still aim our outbound requests wherever they like" is
  // not a capability a suspended tenant should keep.
  if (p.company.status !== "active")
    return {
      ok: false,
      response: roadmapError(
        "company_paused",
        "Changes are paused for your company right now. Contact XL.net.",
        403
      ),
    };
  return {
    ok: true,
    actor: {
      scope: { companyId: p.company.id },
      userId: p.userId,
      email: p.email,
      laneKey: p.company.id,
    },
  };
}

/** Per-USER minute bucket for saving a row: a local single-row write, so
 * the per-minute window applies (the directory-round rule: per-hour windows
 * are for calls with EXTERNAL cost). */
export function limitPlatformWrite(actor: PlatformActor): Response | null {
  return rateLimit(
    `roadmap:platform:${actor.userId}`,
    60,
    ROADMAP_CAPS.platformWritesPerUserPerMinute
  );
}

/** Reachability checks leave our network, so they get an HOUR window and a
 * per-LANE ceiling on top of the per-user one. Without the lane ceiling, a
 * company with several admins could aim three times the traffic at one
 * third-party host through us. */
export function limitUrlCheck(actor: PlatformActor): Response | null {
  const perUser = rateLimit(
    `roadmap:urlcheck:${actor.userId}`,
    3600,
    ROADMAP_CAPS.urlChecksPerUserPerHour
  );
  if (perUser) return perUser;
  return rateLimit(
    `roadmap:urlcheck:lane:${actor.laneKey}`,
    3600,
    ROADMAP_CAPS.urlChecksPerCompanyPerHour
  );
}
