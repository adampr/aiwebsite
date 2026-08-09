// The ONE page-side lane resolver for the phase 09/10/11 step pages
// (§5.20).
//
// THE INVARIANT THIS EXISTS TO SATISFY: the (steps) layout admits xl.net
// staff BEFORE the trusted-principal gate, so any page under (steps) must
// either render a staff variant or redirect staff somewhere real. A page
// that returns null for staff renders a BLANK SHELL, because the layout's
// denial screens only exist on the non-staff path. STAFF_STEP_HREFS points
// all three of these pages at THEMSELVES (there is nowhere else to send
// them: unlike governance, there is no public equivalent), so redirecting
// would be an infinite loop and serving the staff lane is the only correct
// answer. Hence this helper, shared by all three pages so none of them can
// quietly forget.
//
// Reads are member-visible in both lanes; writes are admin-only and are
// re-derived server-side by requirePlatformAdmin in the routes. isAdmin
// here selects UI affordances ONLY.

import { readStaffPage, requireRoadmapPage } from "@/lib/roadmap/access";
import { STAFF_LINK_SCOPE, type LinkScope } from "@/lib/roadmap/db";
import { STAFF_LANE_DOMAIN } from "@/lib/roadmap/config";

export type PlatformPageView =
  | {
      ok: true;
      scope: LinkScope;
      isAdmin: boolean;
      /** The lane's VERIFIED domain. Rung 2 and rung 3 are both bound to
       * it, and publicRow needs it to tell the client whether the attest
       * control may appear. */
      internalDomain: string;
      /** Whose platform this is, for copy. */
      ownerName: string;
      staff: boolean;
    }
  | { ok: false };

export async function readPlatformPage(
  path: string
): Promise<PlatformPageView> {
  const staff = await readStaffPage();
  if (staff) {
    return {
      ok: true,
      scope: STAFF_LINK_SCOPE,
      isAdmin: staff.globalAdmin,
      internalDomain: STAFF_LANE_DOMAIN,
      ownerName: "XL.net",
      staff: true,
    };
  }
  const gate = await requireRoadmapPage(path);
  if (!gate.ok || !gate.principal.company) return { ok: false };
  return {
    ok: true,
    scope: { companyId: gate.principal.company.id },
    isAdmin: gate.principal.companyRole === "admin",
    internalDomain: gate.principal.company.domain,
    ownerName: gate.principal.company.name,
    staff: false,
  };
}
