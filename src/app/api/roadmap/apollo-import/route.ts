// POST - Apollo directory import (§5.18 step 2). Two lanes, one behavior:
// the caller's company (company-admin only), or the XL.net STAFF lane
// (staff-parity round: readStaffPage selects the branch, requireGlobalAdmin
// authorizes it, scope = NULL lane, limiter keys use the literal "staff"
// segment, which can never collide with a company uuid). The 3/h limiter
// doubles as the double-click fence; the per-import page cap keeps the
// whole run inside one request well under proxy timeouts. Partial imports
// KEEP the rows already upserted and say so. The admin-facing copy never
// names server env vars.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import {
  readStaffPage,
  requireCompanyAdmin,
  requireGlobalAdmin,
} from "@/lib/roadmap/access";
import { runApolloImport } from "@/lib/roadmap/apollo";
import { notifyApolloImport } from "@/lib/roadmap/notify";
import { ROADMAP_CAPS, STAFF_LANE_DOMAIN } from "@/lib/roadmap/config";
import {
  STAFF_DIRECTORY_SCOPE,
  type DirectoryScope,
} from "@/lib/roadmap/db";
import {
  okJson,
  rateLimit,
  requireRoadmapWritesEnabled,
  roadmapError,
} from "@/lib/roadmap/http";

/** trigger is an ADVISORY label (client-supplied): "auto" can only REDUCE
 * service (its own tighter sub-limit + audit-trail note), never grant. */
async function parseTrigger(req: Request): Promise<"auto" | "manual"> {
  try {
    const body = (await req.json()) as { trigger?: unknown };
    return body?.trigger === "auto" ? "auto" : "manual";
  } catch {
    return "manual";
  }
}

/** The shared lane body: limits, the import itself, and the outcome
 * mapping. One implementation so the two lanes cannot drift. laneKey is
 * the company uuid or the "staff" sentinel. */
async function runLane(opts: {
  req: Request;
  scope: DirectoryScope;
  laneKey: string;
  domain: string;
  adminEmail: string;
}): Promise<Response> {
  const trigger = await parseTrigger(opts.req);
  if (trigger === "auto") {
    const autoLimited = rateLimit(
      `roadmap:apollo:auto:${opts.laneKey}`,
      3600,
      ROADMAP_CAPS.apolloAutoKicksPerCompanyPerHour
    );
    if (autoLimited) return autoLimited;
  }
  const limited = rateLimit(
    `roadmap:apollo:${opts.laneKey}`,
    3600,
    ROADMAP_CAPS.apolloImportsPerCompanyPerHour
  );
  if (limited) return limited;

  const result = await runApolloImport({
    scope: opts.scope,
    companyDomain: opts.domain,
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
    trigger,
    staffLane: opts.laneKey === "staff",
    adminEmail: opts.adminEmail,
    companyDomain: opts.domain,
    added: result.added,
    updated: result.updated,
    keptManual: result.keptManual,
    skippedSuppressed: result.skippedSuppressed,
    callsUsed: result.callsUsed,
    partial: result.partial,
  }).catch(() => undefined);
  return okJson(result);
}

export async function POST(req: Request): Promise<Response> {
  const staff = await readStaffPage();
  if (staff) {
    const admin = await requireGlobalAdmin();
    if (!admin.ok) return admin.response;
    const disabled = requireRoadmapWritesEnabled();
    if (disabled) return disabled;
    // No company_paused analogue: the staff lane has no companies row;
    // ROADMAP_ENABLED is its only write kill switch (deliberate).
    return runLane({
      req,
      scope: STAFF_DIRECTORY_SCOPE,
      laneKey: "staff",
      domain: STAFF_LANE_DOMAIN,
      adminEmail: admin.email,
    });
  }

  const gate = await requireCompanyAdmin();
  if (!gate.ok) return gate.response;
  const p = gate.principal;
  const disabled = requireRoadmapWritesEnabled();
  if (disabled) return disabled;
  // Round 3: a paused company must not receive system-initiated PII imports
  // (the guards check membership, not status; this route enforces it).
  if (p.company.status !== "active")
    return roadmapError(
      "company_paused",
      "Imports are paused for your company right now. Contact XL.net.",
      403
    );
  return runLane({
    req,
    scope: { companyId: p.company.id },
    laneKey: p.company.id,
    domain: p.company.domain,
    adminEmail: p.email,
  });
}
