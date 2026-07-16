// POST — kick, retry, or partially skip research for a project (§5.12).
// mode:"partial" is the "start the questions anyway" path after a research
// failure: no crawl, no Tavily, no brain; the project moves straight to
// drafting with an honest gap-flagged brief and bank question 1.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { CAPS, governanceEnabled } from "@/lib/governance/config";
import { fetchOwnedProject } from "@/lib/governance/db";
import { govError, NOT_FOUND, okJson, rateLimit, requireUser } from "@/lib/governance/http";
import { kickResearch } from "@/lib/governance/kick";
import { emptyBrief } from "@/lib/governance/research";
import { pickNextBankQuestion } from "@/lib/governance/turn";
import type { GovernanceKind } from "@/lib/governance/types";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const user = await requireUser();
  if (user instanceof Response) return user;
  if (!governanceEnabled(process.env))
    return govError(
      "feature_disabled",
      "New drafting is paused right now. Existing projects and downloads still work.",
      503
    );
  const { id } = await ctx.params;
  const limited = rateLimit(`gov:research:${user.userId}`, 60, 6);
  if (limited) return limited;

  let mode: "full" | "partial" = "full";
  try {
    const body = (await req.json()) as { mode?: unknown };
    if (body?.mode === "partial") mode = "partial";
  } catch {
    // empty body = full
  }

  const row = await fetchOwnedProject(user.userId, id);
  if (!row) return NOT_FOUND();

  if (mode === "partial") {
    if (row.status !== "research_failed" && row.status !== "queued")
      return govError(
        "invalid_request",
        "Partial start is only available when research did not finish.",
        409
      );
    const kind = row.kind as GovernanceKind;
    const nextQuestion = pickNextBankQuestion(kind, new Set(), row.rev + 1);
    const P = schema.governanceProjects;
    const updated = await db
      .update(P)
      .set({
        status: "drafting",
        researchJson: JSON.stringify(emptyBrief(["research_failed"])),
        nextQuestionJson: nextQuestion ? JSON.stringify(nextQuestion) : null,
        researchProgressJson: null,
        rev: row.rev + 1,
        lastActivityAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(P.id, id),
          eq(P.userId, user.userId),
          inArray(P.status, ["research_failed", "queued"])
        )
      )
      .returning({ id: P.id });
    if (!updated.length) return govError("research_running", "The project state changed. Reload.", 409);
    return okJson({ status: "drafting" }, 200);
  }

  // Full research (retry / dequeue). Distinguish the two claim-refusal causes
  // for honest client copy.
  const outcome = await kickResearch(id, user.userId);
  if (outcome.status === "researching") return okJson({ status: "researching" }, 202);
  if (outcome.status === "queued")
    return okJson({ status: "queued", reason: outcome.reason }, 202);
  const runsToday =
    row.researchRunsDate &&
    new Date(row.researchRunsDate).toDateString() === new Date().toDateString()
      ? row.researchRuns
      : 0;
  if (runsToday >= CAPS.researchRunsPerProjectPerDay)
    return govError(
      "research_cap",
      "Research has run several times today for this project. It resets at midnight UTC.",
      429
    );
  return govError("research_running", "Research is already running.", 409);
}
