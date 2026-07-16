// POST — one Q&A turn (or a review-phase revision) (§5.12), async since the
// Cloudflare-524 fix: preflight -> budget -> atomic turn claim -> 202
// {pending} -> in-process worker (turn-runner.ts) -> the poll (GET view)
// surfaces success (rev advanced) or the persisted failure. mode:"async" is
// required: a markerless POST is a stale pre-async client that would spread
// the 202 body into its view, so it gets a reload-this-page 409 instead.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { after } from "next/server";
import { brainHealthy, newId } from "@/lib/governance/brain";
import { CAPS, governanceEnabled } from "@/lib/governance/config";
import {
  effectiveBrainDailyCap,
  isBudgetExemptEmail,
  notifyBudgetHit,
} from "@/lib/governance/budget";
import {
  claimTurn,
  deployInProgress,
  fetchOwnedProject,
  trySpendBudget,
  type ProjectRow,
} from "@/lib/governance/db";
import { govError, NOT_FOUND, okJson, rateLimit, requireUser } from "@/lib/governance/http";
import { runTurn } from "@/lib/governance/turn-runner";
import type { NextQuestion } from "@/lib/governance/types";

type Ctx = { params: Promise<{ id: string }> };

function parse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function turnFresh(row: ProjectRow): boolean {
  return (
    !!row.turnStartedAt &&
    Date.now() - row.turnStartedAt.getTime() < CAPS.turnStaleMs
  );
}

/** 202 body for an accepted (or replayed-accept) async turn. */
function accepted(row: ProjectRow, promptId: string, questionId: string) {
  return okJson(
    {
      pending: true,
      rev: row.rev,
      promptId,
      questionId,
      startedAt: (row.turnStartedAt ?? new Date()).toISOString(),
    },
    202
  );
}

const TURN_PENDING_COPY =
  "Tron is already working on an answer for this project (maybe in another tab). This page will catch up in a moment.";

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
  const limited = rateLimit(`gov:answer:${user.userId}`, 60, 6);
  if (limited) return limited;

  let body: {
    questionId?: unknown;
    answer?: unknown;
    skipped?: unknown;
    promptId?: unknown;
    mode?: unknown;
    focusSections?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return govError("invalid_request", "Bad JSON body.", 400);
  }
  // Version negotiation: pre-async clients send no mode and would spread a
  // 202 accept body into their view (undefined rev/documents). Refuse them
  // with copy that names the fix; the typed answer survives in their box.
  if (body.mode !== "async")
    return govError(
      "invalid_request",
      "This page is from before an update. Reload the page, then send your answer again; it stays right here in the box.",
      409
    );
  const questionId = typeof body.questionId === "string" ? body.questionId : "";
  const answer = typeof body.answer === "string" ? body.answer.trim() : "";
  const skipped = body.skipped === true;
  // Open-item resolver batches (§5.12): "slug#section" pairs the revision
  // targets, serialized verbatim in the prompt so the model can see the text
  // it must edit. Shape-checked here; the worker validates them against the
  // actual docs (bogus refs are dropped, never an error: they only widen
  // prompt focus).
  const focusSections = Array.isArray(body.focusSections)
    ? body.focusSections
        .filter((f): f is string => typeof f === "string" && f.length <= 130)
        .slice(0, 20)
    : [];
  const promptId =
    typeof body.promptId === "string" && /^gov_[a-z0-9_]{4,40}$/.test(body.promptId)
      ? body.promptId
      : newId("gov");
  if (!questionId) return govError("invalid_request", "questionId required.", 400);
  if (answer.length > CAPS.answerMaxChars)
    return govError(
      "answer_too_long",
      `Keep answers under ${CAPS.answerMaxChars} characters. Plain words are fine.`,
      400
    );
  if (!skipped && !answer)
    return govError("invalid_request", "Type an answer or skip the question.", 400);

  const row = await fetchOwnedProject(user.userId, id);
  if (!row) return NOT_FOUND();
  const revise = row.status === "review" && questionId === "revise";

  if (row.status !== "drafting" && !revise)
    return govError(
      "invalid_request",
      row.status === "review"
        ? "The draft is in review: use the revise box."
        : "This project is not taking answers right now.",
      409
    );

  const nextQuestion = parse<NextQuestion | null>(row.nextQuestionJson, null);
  if (!revise) {
    if (!nextQuestion || nextQuestion.id !== questionId)
      return govError(
        "stale_question",
        "This question was already answered (maybe in another tab).",
        409
      );
    if (row.answersCount >= CAPS.answersPerProject)
      return govError(
        "answer_cap",
        "We have covered a lot of ground on this one. Review the draft and confirm it.",
        409
      );
  }

  // A fresh running claim: replay the accept for the same retry
  // (transport-retry idempotency — nothing spawns, nothing spends); anything
  // else waits its turn. Failed/stale records fall through to the claim.
  if (turnFresh(row)) {
    if (row.turnPromptId === promptId)
      return accepted(row, promptId, questionId);
    return govError("turn_pending", TURN_PENDING_COPY, 409);
  }

  // Mid-deploy the process is about to die; don't accept work it can't
  // finish. Same recovery as a brain outage: answer kept, client rechecks.
  if (deployInProgress())
    return govError(
      "brain_unavailable",
      "Tron's drafting engine is restarting for an update. Your answer is kept below; this page will keep checking.",
      503,
      { retriable: true }
    );

  if (!(await brainHealthy()))
    return govError(
      "brain_unavailable",
      "Tron's drafting engine is offline right now. Your answer is kept below; this page will keep checking.",
      503,
      { retriable: true }
    );
  // Admin accounts draft without spending the shared ledger (budget.ts).
  const budgetExempt = isBudgetExemptEmail(user.email);
  if (
    !budgetExempt &&
    !(await trySpendBudget("brain_calls", 1, await effectiveBrainDailyCap()))
  ) {
    void notifyBudgetHit("global_brain", {
      who: user.email,
      operation: "drafting turn",
    });
    return govError(
      "budget_exhausted",
      "Tron has hit today's drafting budget. Your work is saved; come back tomorrow.",
      429
    );
  }

  const attemptId = newId("govt");
  const claimed = await claimTurn({
    id: row.id,
    userId: user.userId,
    expectedRev: row.rev,
    promptId,
    attemptId,
    questionId,
  });
  if (!claimed) {
    // Lost a race between fetch and claim; re-read and answer honestly.
    const now = await fetchOwnedProject(user.userId, id);
    if (!now) return NOT_FOUND();
    if (now.rev !== row.rev)
      return govError(
        "stale_question",
        "This question was already answered (maybe in another tab).",
        409
      );
    if (turnFresh(now) && now.turnPromptId === promptId)
      return accepted(now, promptId, questionId); // duplicate won the claim
    return govError("turn_pending", TURN_PENDING_COPY, 409);
  }

  const job = {
    row,
    userId: user.userId,
    questionId,
    answer,
    skipped,
    revise,
    focusSections,
    promptId,
    attemptId,
    budgetExempt,
  };
  after(() => runTurn(job)); // runTurn never throws; outcome lands on the row
  const claimedRow = { ...row, turnStartedAt: new Date() } as ProjectRow;
  return accepted(claimedRow, promptId, questionId);
}
