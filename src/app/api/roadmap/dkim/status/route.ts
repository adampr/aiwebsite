// GET - cached DKIM verdict for the caller's company domain (§5.18, the
// email-lane sub-surface of step 04).
// Read-class: NOT gated by the kill switch (reads stay up). Domain ALWAYS
// from the server-derived principal. Own rate key (distinct from portal
// reads: a cache miss triggers outbound DNS).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { requireCompanyMember } from "@/lib/roadmap/access";
import { checkDkim } from "@/lib/roadmap/dkim";
import { ROADMAP_CAPS } from "@/lib/roadmap/config";
import { okJson, rateLimit } from "@/lib/roadmap/http";

export async function GET(): Promise<Response> {
  const gate = await requireCompanyMember();
  if (!gate.ok) return gate.response;
  const p = gate.principal;
  const limited = rateLimit(
    `roadmap:dkim:status:${p.userId}`,
    3600,
    ROADMAP_CAPS.dkimStatusReadsPerUserPerHour
  );
  if (limited) return limited;
  const check = await checkDkim(p.company.domain);
  return okJson(check);
}
