// POST - confirm the final draft (review -> done) (§5.12). Refuses while
// any non-stub section still holds untouched scaffold text (template
// placeholders are not governance content) AND while any [TO CONFIRM]
// marker remains (owner ruling 2026-07-16: a FINAL draft carries zero
// markers; each one is resolved by the user in the review panel, by a typed
// fact or an explicit keep-as-drafted, never by silent acceptance). The
// marker count is the LENIENT scan, so a malformed marker that the item
// list cannot parse still blocks. Draft downloads keep working regardless,
// so nothing is stranded.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { placeholderSectionMap } from "@/lib/governance/blueprints";
import { CAPS } from "@/lib/governance/config";
import { confirmProject, fetchOwnedProject } from "@/lib/governance/db";
import { govError, okJson, rateLimit, requireUser } from "@/lib/governance/http";
import { openConfirmTotal } from "@/lib/governance/view";
import type { GovernanceDoc, GovernanceKind } from "@/lib/governance/types";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx): Promise<Response> {
  const user = await requireUser();
  if (user instanceof Response) return user;
  // Deliberately NOT gated on governanceEnabled: confirm is a zero-AI-call
  // status flip and the kill switch is about spend (config.ts). Since reopen
  // exists (done -> review), gating confirm would strand a reopened project
  // as a watermarked draft with no way back to final while the switch is off.
  const { id } = await ctx.params;
  // Per-project bucket: reopen/confirm cycles on one project (both zero-AI
  // flips) must not exhaust the user's ability to finalize another. Note the
  // token is consumed before the gates below, so 409s spend it too.
  const limited = rateLimit(`gov:confirm:${user.userId}:${id}`, 86_400, 20);
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
    const open = openConfirmTotal(docs);
    if (open > 0)
      return govError(
        "open_items",
        `${open} open ${open === 1 ? "item still needs" : "items still need"} your answer. Resolve each one in the review panel: type the correct fact or keep it as drafted.`,
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
