// POST - one Q&A turn (or a review-phase revision) (§5.12), async since the
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
import { isQuestionEntry } from "@/lib/governance/interview";
import { runTurn, type TurnKind } from "@/lib/governance/turn-runner";
import type {
  GovernanceDoc,
  NextQuestion,
  TranscriptEntry,
} from "@/lib/governance/types";

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

  let body: {
    questionId?: unknown;
    answer?: unknown;
    skipped?: unknown;
    promptId?: unknown;
    mode?: unknown;
    focusSections?: unknown;
    amendIndex?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return govError("invalid_request", "Bad JSON body.", 400);
  }
  // Restyle gets its own bucket: a multi-batch format pass is a legitimate
  // burst of small turns and must not starve (or be starved by) answering.
  const limited =
    body.questionId === "restyle"
      ? rateLimit(`gov:restyle:${user.userId}`, 60, 8)
      : rateLimit(`gov:answer:${user.userId}`, 60, 6);
  if (limited) return limited;
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
  const restyle = questionId === "restyle";
  const amend = questionId === "amend";
  const amendIndex =
    typeof body.amendIndex === "number" &&
    Number.isInteger(body.amendIndex) &&
    body.amendIndex >= 0 &&
    body.amendIndex <= 9999
      ? body.amendIndex
      : null;
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
  if (!skipped && !answer && !restyle)
    return govError("invalid_request", "Type an answer or skip the question.", 400);
  if (amend && !answer)
    return govError("invalid_request", "Type the corrected answer.", 400);
  if (restyle && !focusSections.length)
    return govError("invalid_request", "focusSections required for a format pass.", 400);

  const row = await fetchOwnedProject(user.userId, id);
  if (!row) return NOT_FOUND();
  const revise = row.status === "review" && questionId === "revise";
  // Non-advancing turns (§5.12): a restyle (format pass) or amend (correct
  // an earlier answer) is legal in drafting AND review. Neither consumes the
  // pending question nor counts toward the answer cap, so the stale-question
  // and cap checks below do not apply to them (a post-cap review project
  // must still accept amends).
  const nonAdvancing = restyle || amend;

  if (row.status !== "drafting" && !revise && !(nonAdvancing && row.status === "review"))
    return govError(
      "invalid_request",
      row.status === "review"
        ? "The draft is in review: use the revise box."
        : row.status === "done"
          ? "This draft is final. Reopen it from the final panel to make changes."
          : "This project is not taking answers right now.",
      409
    );

  if (restyle) {
    if (!row.styleSampleText)
      return govError(
        "invalid_request",
        "Attach a format sample first, then apply it.",
        409
      );
    // Accept-time size check: a stale client's oversized batch would
    // deterministically fail validation and waste the brain call.
    const docs = parse<GovernanceDoc[]>(row.documentsJson, []);
    let sum = 0;
    for (const f of focusSections) {
      const i = f.indexOf("#");
      if (i <= 0) continue;
      const d = docs.find((x) => x.slug === f.slice(0, i));
      const s = d?.sections.find((x) => x.id === f.slice(i + 1));
      sum += (s?.markdown.length ?? 0) + 200;
    }
    if (sum > CAPS.turnOpMarkdownTargetChars)
      return govError(
        "invalid_request",
        "That batch is too large for one format pass. Reload the page and try again.",
        400
      );
  }

  if (amend) {
    const transcript = parse<TranscriptEntry[]>(row.transcriptJson, []);
    const orig = amendIndex !== null ? transcript[amendIndex] : undefined;
    if (!orig || !isQuestionEntry(orig))
      return govError(
        "invalid_request",
        "That answer can no longer be changed.",
        400
      );
  }

  const nextQuestion = parse<NextQuestion | null>(row.nextQuestionJson, null);
  if (!revise && !nonAdvancing) {
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
  // (transport-retry idempotency - nothing spawns, nothing spends); anything
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

  // Skipping an open-item chase question ("qi_" id, owner rule 2026-07-17)
  // is a deterministic host flip to review: the worker makes no brain call,
  // so it needs neither a healthy brain nor a budget spend.
  const chaseSkip =
    !revise && skipped && !!nextQuestion && nextQuestion.id.startsWith("qi_");
  if (!chaseSkip && !(await brainHealthy()))
    return govError(
      "brain_unavailable",
      "Tron's drafting engine is offline right now. Your answer is kept below; this page will keep checking.",
      503,
      { retriable: true }
    );
  // Admin accounts draft without spending the shared ledger (budget.ts).
  const budgetExempt = isBudgetExemptEmail(user.email);
  if (
    !chaseSkip &&
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

  const kind: TurnKind = revise
    ? "revise"
    : restyle
      ? "restyle"
      : amend
        ? "amend"
        : "answer";
  const job = {
    row,
    userId: user.userId,
    questionId,
    answer,
    skipped,
    kind,
    focusSections,
    ...(amend && amendIndex !== null ? { amendIndex } : {}),
    promptId,
    attemptId,
    budgetExempt,
  };
  after(() => runTurn(job)); // runTurn never throws; outcome lands on the row
  const claimedRow = { ...row, turnStartedAt: new Date() } as ProjectRow;
  return accepted(claimedRow, promptId, questionId);
}
