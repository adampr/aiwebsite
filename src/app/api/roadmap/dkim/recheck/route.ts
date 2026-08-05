// POST - fresh DKIM probe bypassing the cache (§5.18 email lane, the dialog's
// Recheck button). Mutates nothing (a DNS read), so NOT gated by the kill
// switch. The per-company key bounds a tenant's total outbound DNS
// regardless of headcount.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { requireCompanyMember } from "@/lib/roadmap/access";
import { checkDkim } from "@/lib/roadmap/dkim";
import { ROADMAP_CAPS } from "@/lib/roadmap/config";
import { okJson, rateLimit } from "@/lib/roadmap/http";

export async function POST(): Promise<Response> {
  const gate = await requireCompanyMember();
  if (!gate.ok) return gate.response;
  const p = gate.principal;
  const perUser = rateLimit(
    `roadmap:dkim:recheck:${p.userId}`,
    3600,
    ROADMAP_CAPS.dkimRechecksPerUserPerHour
  );
  if (perUser) return perUser;
  const perCompany = rateLimit(
    `roadmap:dkim:recheck:co:${p.company.id}`,
    3600,
    ROADMAP_CAPS.dkimRechecksPerCompanyPerHour
  );
  if (perCompany) return perCompany;
  // Recheck is a user waiting on a click: allow a longer budget than the
  // hub render before degrading to the timed-out unknown.
  const check = await checkDkim(p.company.domain, { fresh: true, budgetMs: 6000 });
  return okJson(check);
}
