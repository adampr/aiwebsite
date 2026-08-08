// POST - global-admin actions for the roadmap console (§5.18). ONE dispatch
// route, every action behind requireGlobalAdmin (provider-checked: bare
// isAdmin is forgeable via the Microsoft common-tenant lane and this feature
// adds zero provider-unchecked admin surfaces). ?companyId-style request
// params are legal here ONLY because this guard holds.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { requireGlobalAdmin } from "@/lib/roadmap/access";
import {
  approveAdminRequest,
  companyById,
  denyAdminRequest,
  grantAdminByEmail,
  purgeCompany,
  revokeAdmin,
  setCompanyName,
  setCompanyStatus,
} from "@/lib/roadmap/db";
import { notifyRequestApproved } from "@/lib/roadmap/notify";
import { okJson, rateLimit, roadmapError } from "@/lib/roadmap/http";

export async function POST(req: Request): Promise<Response> {
  const ga = await requireGlobalAdmin();
  if (!ga.ok) return ga.response;
  const limited = rateLimit(`roadmap:gadmin:${ga.userId}`, 3600, 120);
  if (limited) return limited;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return roadmapError("invalid_request", "Send JSON.", 400);
  }
  const action = typeof body.action === "string" ? body.action : "";
  const companyId = typeof body.companyId === "string" ? body.companyId : "";

  switch (action) {
    case "approve_request": {
      const requestId = typeof body.requestId === "string" ? body.requestId : "";
      const approved = await approveAdminRequest({
        requestId,
        deciderUserId: ga.userId,
        deciderEmail: ga.email,
      });
      if (!approved)
        return roadmapError("not_found", "No pending request with that id.", 404);
      const company = await companyById(approved.companyId);
      await notifyRequestApproved({
        requesterEmail: approved.requesterEmail,
        companyName: company?.name ?? approved.companyId,
        approverEmail: ga.email,
      }).catch(() => undefined);
      return okJson({ approved: true });
    }
    case "deny_request": {
      const requestId = typeof body.requestId === "string" ? body.requestId : "";
      const denied = await denyAdminRequest({
        requestId,
        deciderUserId: ga.userId,
        deciderEmail: ga.email,
      });
      if (!denied)
        return roadmapError("not_found", "No pending request with that id.", 404);
      // No requester email on deny: company-facing behavior is "reads as
      // expiry" by ruling.
      return okJson({ denied: true });
    }
    case "suspend":
    case "activate": {
      const done = await setCompanyStatus(
        companyId,
        action === "suspend" ? "suspended" : "active"
      );
      return done
        ? okJson({ status: action === "suspend" ? "suspended" : "active" })
        : roadmapError("not_found", "No company with that id.", 404);
    }
    case "rename": {
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
      if (name.length < 2)
        return roadmapError("invalid_request", "Give the company a name.", 400);
      const done = await setCompanyName(companyId, name);
      return done
        ? okJson({ renamed: true })
        : roadmapError("not_found", "No company with that id.", 404);
    }
    case "grant_admin": {
      const company = await companyById(companyId);
      if (!company)
        return roadmapError("not_found", "No company with that id.", 404);
      const email = typeof body.email === "string" ? body.email.trim() : "";
      const result = await grantAdminByEmail({
        companyId,
        companyDomain: company.domain,
        targetEmail: email,
        granterEmail: ga.email,
      });
      if (result === "wrong_domain")
        return roadmapError(
          "wrong_domain",
          `A company admin's account must be on ${company.domain}. A role never follows a user across companies.`,
          400
        );
      if (result === "no_user")
        return roadmapError(
          "no_user",
          "That person has not signed in yet. Have them sign in once first.",
          404
        );
      return okJson({ granted: result === "granted", already: result === "already" });
    }
    case "revoke_admin": {
      const targetUserId =
        typeof body.targetUserId === "string" ? body.targetUserId : "";
      const done = await revokeAdmin({ companyId, targetUserId });
      return done
        ? okJson({ revoked: true })
        : roadmapError("not_found", "No such admin role.", 404);
    }
    case "purge": {
      // Typed-domain confirm: the client must echo the exact domain.
      const company = await companyById(companyId);
      if (!company)
        return roadmapError("not_found", "No company with that id.", 404);
      const confirm = typeof body.confirmDomain === "string" ? body.confirmDomain : "";
      if (confirm !== company.domain)
        return roadmapError(
          "confirm_mismatch",
          "Type the company's exact domain to confirm deletion.",
          400
        );
      const purged = await purgeCompany(companyId);
      return okJson({
        purged: true,
        submissionsDeleted: purged.submissions,
        requestsDeleted: purged.requests,
      });
    }
    default:
      return roadmapError("invalid_request", "Unknown action.", 400);
  }
}
