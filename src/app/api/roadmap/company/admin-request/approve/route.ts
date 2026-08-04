// POST - approve (or deny) an admin-access request (§5.18). The emailed link
// is an IDENTIFIER, never a capability: this route re-derives the approver
// predicate server-side from the live session - a global admin, or a current
// admin of the SAME company. The UPDATE ... WHERE status='pending' rowCount
// is the any-one-may-approve race fence.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { readRoadmapPrincipal, requireGlobalAdmin } from "@/lib/roadmap/access";
import {
  adminRequestById,
  approveAdminRequest,
  companyById,
  denyAdminRequest,
} from "@/lib/roadmap/db";
import { notifyRequestApproved } from "@/lib/roadmap/notify";
import { ROADMAP_CAPS } from "@/lib/roadmap/config";
import {
  okJson,
  rateLimit,
  requireRoadmapWritesEnabled,
  roadmapError,
} from "@/lib/roadmap/http";

// One generic body for every non-approver outcome (unknown id, expired,
// wrong company, signed-out handled by the 401): the link must be no oracle
// for company existence or request state.
const NOT_VALID = () =>
  roadmapError(
    "not_valid",
    "This approval link is not valid for the account you are signed in as.",
    404
  );

export async function POST(req: Request): Promise<Response> {
  const disabled = requireRoadmapWritesEnabled();
  if (disabled) return disabled;
  let requestId = "";
  let action: "approve" | "deny" = "approve";
  try {
    const body = (await req.json()) as { req?: unknown; action?: unknown };
    requestId = typeof body.req === "string" ? body.req : "";
    if (body.action === "deny") action = "deny";
  } catch {
    requestId = "";
  }
  if (!requestId) return NOT_VALID();

  // Resolve the approver: global admin first (may approve any company),
  // else a trusted company-admin principal of the request's company.
  const ga = await requireGlobalAdmin();
  let approver: { userId: string; email: string } | null = ga.ok
    ? { userId: ga.userId, email: ga.email }
    : null;
  const row = await adminRequestById(requestId);
  if (!row) return NOT_VALID();
  if (!approver) {
    const principal = await readRoadmapPrincipal();
    if (
      principal.ok &&
      principal.principal.companyRole === "admin" &&
      principal.principal.company &&
      principal.principal.company.id === row.companyId
    ) {
      approver = {
        userId: principal.principal.userId,
        email: principal.principal.email,
      };
    }
  }
  if (!approver) return NOT_VALID();
  const limited = rateLimit(
    `roadmap:approve:${approver.userId}`,
    3600,
    ROADMAP_CAPS.adminApprovePerUserPerHour
  );
  if (limited) return limited;

  // Deny is a global-admin console action only; company-facing UI shows no
  // denied state (non-approval reads as expiry).
  if (action === "deny") {
    if (!ga.ok) return NOT_VALID();
    const denied = await denyAdminRequest({
      requestId,
      deciderUserId: approver.userId,
      deciderEmail: approver.email,
    });
    return denied ? okJson({ denied: true }) : NOT_VALID();
  }

  const approved = await approveAdminRequest({
    requestId,
    deciderUserId: approver.userId,
    deciderEmail: approver.email,
  });
  if (!approved) return NOT_VALID();
  const company = await companyById(approved.companyId);
  await notifyRequestApproved({
    requesterEmail: approved.requesterEmail,
    companyName: company?.name ?? approved.companyId,
    approverEmail: approver.email,
  }).catch(() => undefined);
  return okJson({ approved: true });
}
