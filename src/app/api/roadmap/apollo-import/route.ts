// POST - Apollo directory import for the caller's company (§5.18 step 2,
// company-admin only). The 2/h/company limiter doubles as the double-click
// fence; the per-import page cap keeps the whole run inside one request well
// under proxy timeouts. Partial imports KEEP the rows already upserted and
// say so. The admin-facing copy never names server env vars.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { requireCompanyAdmin } from "@/lib/roadmap/access";
import { runApolloImport } from "@/lib/roadmap/apollo";
import { notifyApolloImport } from "@/lib/roadmap/notify";
import { ROADMAP_CAPS } from "@/lib/roadmap/config";
import {
  okJson,
  rateLimit,
  requireRoadmapWritesEnabled,
  roadmapError,
} from "@/lib/roadmap/http";

export async function POST(): Promise<Response> {
  const gate = await requireCompanyAdmin();
  if (!gate.ok) return gate.response;
  const p = gate.principal;
  const disabled = requireRoadmapWritesEnabled();
  if (disabled) return disabled;
  const limited = rateLimit(
    `roadmap:apollo:${p.company.id}`,
    3600,
    ROADMAP_CAPS.apolloImportsPerCompanyPerHour
  );
  if (limited) return limited;

  const result = await runApolloImport({
    companyId: p.company.id,
    companyDomain: p.company.domain,
  });
  if (result.outcome === "not_configured")
    return roadmapError(
      "not_configured",
      "Apollo import is not set up yet. Add people manually, or contact XL.net.",
      503
    );
  if (result.outcome === "api_error")
    return roadmapError(
      "apollo_down",
      "Apollo did not answer. Nothing was imported; try again in a few minutes, or add people manually.",
      502
    );
  await notifyApolloImport({
    adminEmail: p.email,
    companyDomain: p.company.domain,
    added: result.added,
    updated: result.updated,
    keptManual: result.keptManual,
    skippedSuppressed: result.skippedSuppressed,
    callsUsed: result.callsUsed,
    partial: result.partial,
  }).catch(() => undefined);
  return okJson(result);
}
