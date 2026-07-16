// POST — confirm the final draft (review -> done) (§5.12). Refuses while
// any non-stub section still holds untouched scaffold text: the final stamp
// is the one claim that the interview finished the set, and template
// placeholders are not governance content. Open [TO CONFIRM] items do NOT
// block (intentional asymmetry: unverified facts are the user's to accept;
// undrafted sections are not content at all). Draft downloads keep working
// regardless, so nothing is stranded.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { placeholderSectionMap } from "@/lib/governance/blueprints";
import { CAPS, governanceEnabled } from "@/lib/governance/config";
import { confirmProject, fetchOwnedProject } from "@/lib/governance/db";
import { govError, okJson, rateLimit, requireUser } from "@/lib/governance/http";
import type { GovernanceDoc, GovernanceKind } from "@/lib/governance/types";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx): Promise<Response> {
  const user = await requireUser();
  if (user instanceof Response) return user;
  if (!governanceEnabled(process.env))
    return govError(
      "feature_disabled",
      "New drafting is paused right now. Existing projects and downloads still work.",
      503
    );
  const { id } = await ctx.params;
  const limited = rateLimit(`gov:confirm:${user.userId}`, 86_400, 10);
  if (limited) return limited;

  // Defensive parse (view.ts idiom): a corrupt column degrades to "no
  // placeholders found" (fail open), never a 500 that bricks confirm.
  const row = await fetchOwnedProject(user.userId, id);
  if (
    row?.turnStartedAt &&
    Date.now() - row.turnStartedAt.getTime() < CAPS.turnStaleMs
  )
    return govError(
      "turn_pending",
      "Tron is still applying your last revision. Give it a moment, then confirm.",
      409
    );
  if (row) {
    let docs: GovernanceDoc[] = [];
    try {
      docs = JSON.parse(row.documentsJson) as GovernanceDoc[];
    } catch {
      docs = [];
    }
    const undrafted = Object.values(
      placeholderSectionMap(row.kind as GovernanceKind, docs)
    ).reduce((n, secs) => n + secs.length, 0);
    if (undrafted > 0)
      return govError(
        "invalid_request",
        `${undrafted} ${undrafted === 1 ? "section is" : "sections are"} not drafted yet. Ask Tron to draft them in the revision box, then confirm.`,
        409
      );
  }

  const ok = await confirmProject(user.userId, id);
  if (!ok)
    return govError(
      "invalid_request",
      "Only a draft in review can be confirmed.",
      409
    );
  return okJson({ status: "done" });
}
