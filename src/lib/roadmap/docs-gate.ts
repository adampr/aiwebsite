// The ONE lane resolver for the governance-doc routes (§5.18 step 1; staff
// governance round, owner ruling 2026-08-18). Two lanes, the directory-gate
// pattern: the XL.net STAFF lane (company_id NULL) and the caller's own
// company. readStaffPage SELECTS the lane; on the staff branch
// requireGlobalAdmin AUTHORIZES every write - the owner's ruling is that
// staff READ the XL.net document and are never funneled into creating one,
// so upload, attach and remove all stay with global admins there, while the
// company lane keeps its shape untouched (attach member-actionable, upload
// and remove company-admin). A non-admin staffer gets the staff branch's
// 403 and never falls through to the company path (xl.net can never be a
// companies row anyway).
//
// Kill switch and rate limits deliberately stay in the route files, in the
// exact company-lane order they always ran: this gate resolves WHO and
// WHICH LANE, nothing else. The scope it returns is the lane filter every
// governance-doc db function requires, so a missed lane check is a compile
// error.

import {
  readStaffPage,
  requireCompanyAdmin,
  requireCompanyMember,
  requireGlobalAdmin,
} from "@/lib/roadmap/access";
import { STAFF_LANE_DOMAIN } from "@/lib/roadmap/config";
import { STAFF_GOVDOC_SCOPE, type GovDocScope } from "@/lib/roadmap/db";

export type DocsLane =
  | {
      ok: true;
      scope: GovDocScope;
      userId: string;
      email: string;
      /** Rate-limit key fragment for per-tenant ceilings (the PlatformActor
       * shape): the company uuid, or the literal "staff" - the staff lane
       * has no company id, and inventing one would fork the fence. */
      laneKey: string;
      /** The lane's VERIFIED domain (the tenancy key itself), read from the
       * principal / STAFF_LANE_DOMAIN and never from a request: the link
       * lane's url-check rung 2 is only as trustworthy as this value. */
      internalDomain: string;
    }
  | { ok: false; response: Response };

/** Write lane. `kind` picks the COMPANY gate only ("attach" is
 * member-actionable there); the staff branch is global-admin for both. */
export async function docsWriteLane(
  kind: "attach" | "admin"
): Promise<DocsLane> {
  const staff = await readStaffPage();
  if (staff) {
    const admin = await requireGlobalAdmin();
    if (!admin.ok) return admin;
    return {
      ok: true,
      scope: STAFF_GOVDOC_SCOPE,
      userId: admin.userId,
      email: admin.email,
      laneKey: "staff",
      internalDomain: STAFF_LANE_DOMAIN,
    };
  }
  const gate =
    kind === "attach"
      ? await requireCompanyMember()
      : await requireCompanyAdmin();
  if (!gate.ok) return gate;
  const p = gate.principal;
  return {
    ok: true,
    scope: { companyId: p.company.id },
    userId: p.userId,
    email: p.email,
    laneKey: p.company.id,
    internalDomain: p.company.domain,
  };
}

/** Read (download) lane: any verified staff session on the staff lane, any
 * company member on the company lane. */
export async function docsReadLane(): Promise<DocsLane> {
  const staff = await readStaffPage();
  if (staff) {
    return {
      ok: true,
      scope: STAFF_GOVDOC_SCOPE,
      userId: staff.userId,
      email: staff.email,
      laneKey: "staff",
      internalDomain: STAFF_LANE_DOMAIN,
    };
  }
  const gate = await requireCompanyMember();
  if (!gate.ok) return gate;
  const p = gate.principal;
  return {
    ok: true,
    scope: { companyId: p.company.id },
    userId: p.userId,
    email: p.email,
    laneKey: p.company.id,
    internalDomain: p.company.domain,
  };
}
