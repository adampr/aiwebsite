// POST - reopen a final draft (done -> review) (§5.12, owner request
// 2026-07-17). The one inverse of confirm: content untouched, status back to
// review where every edit tool (amend, revise, resolver, restyle) is already
// legal and already gated, and downloads carry the DRAFT watermark again
// until the user confirms final through the same gates as the first time.
// Zero AI calls. Appends a `qId:"reopen"` transcript row as the audit trail;
// the write bumps `rev` and clears the `turn_*` columns (reopenProject in
// db.ts explains the fencing). Gated on `governanceEnabled` like every other
// write: reopening into a workbench where every tool 503s would be a trap.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { governanceEnabled, REVIEW_REOPENED_SUMMARY } from "@/lib/governance/config";
import { fetchOwnedProject, reopenProject } from "@/lib/governance/db";
import { govError, NOT_FOUND, okJson, rateLimit, requireUser } from "@/lib/governance/http";
import type { TranscriptEntry } from "@/lib/governance/types";

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
  // Per-project like confirm's bucket: reopen/confirm cycles on one project
  // must not lock the user out of finalizing another.
  const limited = rateLimit(`gov:reopen:${user.userId}:${id}`, 86_400, 20);
  if (limited) return limited;

  const row = await fetchOwnedProject(user.userId, id);
  if (!row) return NOT_FOUND();
  if (row.status !== "done")
    return govError("invalid_request", "Only a final draft can be reopened.", 409);

  let transcript: TranscriptEntry[] = [];
  try {
    transcript = JSON.parse(row.transcriptJson) as TranscriptEntry[];
  } catch {
    transcript = [];
  }
  const now = new Date().toISOString();
  transcript.push({
    qId: "reopen",
    bankId: null,
    q: "Reopened for changes",
    a: "The final draft went back to review for changes.",
    skipped: false,
    askedAt: now,
    answeredAt: now,
  });

  const ok = await reopenProject({
    userId: user.userId,
    id,
    expectedRev: row.rev,
    transcript,
    reviewSummary: REVIEW_REOPENED_SUMMARY,
  });
  if (!ok)
    // Fence lost (another tab reopened first, or the row aged out between
    // reads): the poll converges either way.
    return govError("invalid_request", "Only a final draft can be reopened.", 409);
  return okJson({ status: "review" });
}
