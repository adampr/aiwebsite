// GET (list) / POST (create) — AI Governance projects (§5.12).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import {
  ACK_TEXT,
  CAPS,
  CONSUMER_EMAIL_DOMAINS,
  governanceEnabled,
  normalizeDomain,
} from "@/lib/governance/config";
import { scaffoldDocuments } from "@/lib/governance/blueprints";
import {
  effectiveCreatesPerUserPerDay,
  isBudgetExemptEmail,
  notifyBudgetHit,
} from "@/lib/governance/budget";
import {
  countActiveProjects,
  countCreatedToday,
  createProject,
  listOwnedProjects,
  sweepExpiredGlobal,
} from "@/lib/governance/db";
import { govError, okJson, rateLimit, requireUser } from "@/lib/governance/http";
import { toProjectSummary } from "@/lib/governance/view";
import { isGovernanceKind } from "@/lib/governance/types";
import { kickResearch } from "@/lib/governance/kick";

export async function GET(): Promise<Response> {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const limited = rateLimit(`gov:list:${user.userId}`, 60, 30);
  if (limited) return limited;
  // Bounded global sweep: expired rows of ANY user go now, so a dead daily
  // timer cannot silently break the 30-day promise for departed users.
  try {
    await sweepExpiredGlobal(25);
  } catch {
    // sweep is best-effort on the read path
  }
  const rows = await listOwnedProjects(user.userId);
  return okJson({ projects: rows.map(toProjectSummary) });
}

export async function POST(req: Request): Promise<Response> {
  const user = await requireUser();
  if (user instanceof Response) return user;
  if (!governanceEnabled(process.env))
    return govError(
      "feature_disabled",
      "New drafting is paused right now. Existing projects and downloads still work.",
      503
    );
  const limited = rateLimit(`gov:create:${user.userId}`, 60, 10);
  if (limited) return limited;

  let body: { kind?: unknown; domain?: unknown; ack?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return govError("invalid_request", "Bad JSON body.", 400);
  }
  if (!isGovernanceKind(body.kind))
    return govError("invalid_request", "Unknown project kind.", 400);
  if (body.ack !== true)
    return govError(
      "ack_required",
      `Please acknowledge before starting: ${ACK_TEXT}`,
      400
    );

  const consumer = CONSUMER_EMAIL_DOMAINS.has(user.emailDomain);
  const rawDomain =
    typeof body.domain === "string" && body.domain.trim()
      ? body.domain
      : consumer
        ? ""
        : user.emailDomain;
  const domain = normalizeDomain(rawDomain);
  if (!domain)
    return govError(
      "invalid_domain",
      consumer
        ? "You signed in with a personal address. Enter your company's website domain."
        : "That does not look like a valid domain.",
      400
    );

  if ((await countActiveProjects(user.userId)) >= CAPS.activeProjectsPerUser)
    return govError(
      "project_cap",
      `You can have ${CAPS.activeProjectsPerUser} projects in progress at once. Finish or delete one first.`,
      409
    );
  const createsCap = await effectiveCreatesPerUserPerDay();
  if (
    !isBudgetExemptEmail(user.email) &&
    (await countCreatedToday(user.userId)) >= createsCap
  ) {
    void notifyBudgetHit("person_creates", {
      who: user.email,
      operation: "create project",
    });
    return govError(
      "create_cap",
      "You have hit the limit for new projects today. It resets at midnight UTC. Your existing projects are unaffected.",
      429
    );
  }

  try {
    await sweepExpiredGlobal(25);
  } catch {
    // best-effort
  }

  const id = await createProject({
    userId: user.userId,
    kind: body.kind,
    domain,
    documents: scaffoldDocuments(body.kind),
  });

  // Auto-kick research; at budget / mid-deploy the project lands in `queued`
  // and the workspace shows the queued state (the poll tells the client when
  // to re-POST /research).
  const kick = await kickResearch(id, user.userId);
  return okJson({ id, status: kick.status }, 201);
}
