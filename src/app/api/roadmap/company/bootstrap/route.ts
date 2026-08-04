// POST - explicit "Set up {domain} workspace" (§5.18). Never a sign-in side
// effect: a trusted, domain-eligible principal clicks a card whose copy
// disclosed (a) first-signer-becomes-admin and (b) XL.net visibility. The
// companies_domain_uq index arbitrates the race; the loser joins as a
// member. Every creation emails the owner unconditionally - that
// notification is the audit control for hostile/wrong first signers.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { requireRoadmapUser } from "@/lib/roadmap/access";
import { bootstrapCompany } from "@/lib/roadmap/db";
import { notifyCompanyCreated } from "@/lib/roadmap/notify";
import { ROADMAP_CAPS } from "@/lib/roadmap/config";
import {
  okJson,
  rateLimit,
  requireRoadmapWritesEnabled,
  roadmapError,
} from "@/lib/roadmap/http";

export async function POST(): Promise<Response> {
  const gate = await requireRoadmapUser();
  if (!gate.ok) return gate.response;
  const p = gate.principal;
  const disabled = requireRoadmapWritesEnabled();
  if (disabled) return disabled;
  const limited = rateLimit(
    `roadmap:bootstrap:${p.userId}`,
    86_400,
    ROADMAP_CAPS.bootstrapPerUserPerDay
  );
  if (limited) return limited;
  if (!p.domainEligible)
    return roadmapError(
      "ineligible_domain",
      "The roadmap is built around a company email domain. Sign in with your work email to set up a workspace.",
      403
    );
  if (p.company)
    return okJson({ outcome: "exists", company: { name: p.company.name } });

  const result = await bootstrapCompany({
    domain: p.emailDomain,
    userId: p.userId,
    email: p.email,
  });
  if (result.outcome === "related_domain")
    return roadmapError(
      "related_domain",
      "A closely related domain already has a workspace here, so this one needs a human look. Contact Tron.Netter@ai.xl.net and the XL.net team will set it up.",
      409
    );
  if (result.outcome === "created") {
    await notifyCompanyCreated({
      domain: result.company.domain,
      creatorEmail: p.email,
    }).catch(() => undefined);
    return okJson({ outcome: "created", company: { name: result.company.name } });
  }
  return okJson({ outcome: "exists", company: { name: result.company.name } });
}
