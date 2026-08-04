// POST - Request [Company] Admin Access (§5.18). Emails adam@xl.net plus
// every current company admin in one send; ANY ONE recipient may approve.
// The emailed link only identifies the request - approval requires a live
// verified approver session on /roadmap/approve-admin. Hardest-capped route
// in the feature: it sends email.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { requireCompanyMember } from "@/lib/roadmap/access";
import {
  companyAdminEmails,
  createAdminRequest,
  deniedAdminRequestInWindow,
  openAdminRequest,
} from "@/lib/roadmap/db";
import { notifyAdminRequest } from "@/lib/roadmap/notify";
import { ROADMAP_CAPS } from "@/lib/roadmap/config";
import {
  okJson,
  rateLimit,
  requireRoadmapWritesEnabled,
  roadmapError,
} from "@/lib/roadmap/http";

export async function POST(): Promise<Response> {
  const gate = await requireCompanyMember();
  if (!gate.ok) return gate.response;
  const p = gate.principal;
  const disabled = requireRoadmapWritesEnabled();
  if (disabled) return disabled;
  if (p.companyRole === "admin")
    return roadmapError(
      "already_admin",
      "You are already a company admin here.",
      409
    );
  const perUser = rateLimit(
    `roadmap:adminreq:${p.userId}`,
    86_400,
    ROADMAP_CAPS.adminRequestPerUserPerDay
  );
  if (perUser) return perUser;
  const perCompany = rateLimit(
    `roadmap:adminreq:co:${p.company.id}`,
    86_400,
    ROADMAP_CAPS.adminRequestPerCompanyPerDay
  );
  if (perCompany) return perCompany;

  const open = await openAdminRequest(p.company.id, p.userId);
  if (open)
    return okJson({
      outcome: "pending",
      requestedAt: open.createdAt,
      expiresAt: open.expiresAt,
    });
  // A denied request keeps the button disarmed until ITS expiry passes, so
  // a denial is observably identical to non-approval (§5.18 ruling).
  const denied = await deniedAdminRequestInWindow(p.company.id, p.userId);
  if (denied)
    return okJson({
      outcome: "pending",
      requestedAt: denied.createdAt,
      expiresAt: denied.expiresAt,
    });

  const admins = await companyAdminEmails(p.company.id);
  const row = await createAdminRequest({
    companyId: p.company.id,
    userId: p.userId,
    email: p.email,
    notifiedEmails: admins,
  });
  await notifyAdminRequest({
    requestId: row.id,
    requesterEmail: p.email,
    companyName: p.company.name,
    companyDomain: p.company.domain,
    adminEmails: admins,
  }).catch(() => undefined);
  return okJson({
    outcome: "requested",
    requestedAt: row.createdAt,
    expiresAt: row.expiresAt,
  });
}
