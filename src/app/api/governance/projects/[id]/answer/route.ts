// POST — one Q&A turn (or a review-phase revision) (§5.12). Synchronous:
// preflight -> budget -> brain JSON turn (90 s) -> parse/repair ladder ->
// server-gated apply in ONE conditional write. The whole route stays under
// nginx's 120 s proxy timeout; a turn that lands after the client gave up is
// recovered client-side by re-GETting and comparing rev.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import {
  brainHealthy,
  buildGovernanceEnvelope,
  callGovernanceBrain,
  newId,
} from "@/lib/governance/brain";
import {
  CAPS,
  REVIEW_FORCED_SUMMARY,
  governanceEnabled,
} from "@/lib/governance/config";
import {
  effectiveBrainDailyCap,
  isBudgetExemptEmail,
  notifyBudgetHit,
} from "@/lib/governance/budget";
import {
  applyTurnWrite,
  fetchOwnedProject,
  trySpendBudget,
} from "@/lib/governance/db";
import { govError, NOT_FOUND, okJson, rateLimit, requireUser } from "@/lib/governance/http";
import {
  buildSystemMessage,
  buildTurnUserMessage,
  repairSystemMessage,
} from "@/lib/governance/prompt";
import {
  applyOps,
  coverageComplete,
  parseTurnJson,
  pickNextBankQuestion,
  progressFor,
  validateTurn,
} from "@/lib/governance/turn";
import { bankById } from "@/lib/governance/blueprints";
import { openConfirmItems } from "@/lib/governance/view";
import type {
  GovernanceDoc,
  GovernanceKind,
  NextQuestion,
  ProjectStatus,
  ResearchBrief,
  TranscriptEntry,
  TurnResult,
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

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const started = Date.now();
  const remaining = () => CAPS.routeDeadlineMs - (Date.now() - started);

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
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return govError("invalid_request", "Bad JSON body.", 400);
  }
  const questionId = typeof body.questionId === "string" ? body.questionId : "";
  const answer = typeof body.answer === "string" ? body.answer.trim() : "";
  const skipped = body.skipped === true;
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
  const kind = row.kind as GovernanceKind;
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

  // Assemble the turn.
  const documents = parse<GovernanceDoc[]>(row.documentsJson, []);
  const transcript = parse<TranscriptEntry[]>(row.transcriptJson, []);
  const covered = new Set(parse<string[]>(row.coveredBankIdsJson, []));
  const brief = parse<ResearchBrief | null>(row.researchJson, null);
  const changedSections = parse<Record<string, string[]> | null>(
    row.changedSectionsJson,
    null
  );
  const question: NextQuestion = revise
    ? {
        id: "revise",
        bankId: null,
        text: "Revision request",
        why: "",
        suggestions: [],
        feeds: [],
      }
    : nextQuestion!;

  const system = buildSystemMessage({
    kind,
    brief,
    forcedReviewSoon: row.answersCount >= CAPS.answersPerProject - 5,
    styleSample: row.styleSampleText
      ? { name: row.styleSampleName ?? "sample", text: row.styleSampleText }
      : null,
  });
  const userMsg = buildTurnUserMessage({
    kind,
    documents,
    transcript,
    coveredBankIds: [...covered],
    question,
    answer,
    skipped,
    changedSections,
    revise,
  });

  const sessionId = `gov_${row.id}`;
  const raw = await callGovernanceBrain(
    buildGovernanceEnvelope({ sessionId, promptId, system, user: userMsg }),
    Math.min(CAPS.brainTurnTimeoutMs, Math.max(10_000, remaining() - 10_000))
  );
  if (raw === null)
    return govError(
      "brain_unavailable",
      "Tron's drafting engine did not answer. Your answer is kept below; try again in a moment.",
      503,
      { retriable: true }
    );

  // Parse -> validate -> at most ONE repair call (new promptId, never reuse
  // the original: the brain replays (sessionId,promptId) verbatim).
  let validation = validateTurn(parseTurnJson(raw), kind);
  if (!validation.ok && remaining() > CAPS.repairMinRemainingMs) {
    if (
      budgetExempt ||
      (await trySpendBudget("brain_calls", 1, await effectiveBrainDailyCap()))
    ) {
      const repairRaw = await callGovernanceBrain(
        buildGovernanceEnvelope({
          sessionId,
          promptId: newId("gov"),
          system: repairSystemMessage(),
          user: `Validation errors:\n${validation.errors.join("\n")}\n\nRaw output to repair:\n${raw.slice(0, 32_000)}`,
        }),
        Math.min(60_000, Math.max(10_000, remaining() - 5_000))
      );
      if (repairRaw) validation = validateTurn(parseTurnJson(repairRaw), kind);
    }
  }
  if (!validation.ok || !validation.turn)
    return govError(
      "invalid_turn",
      "Tron hit a snag applying that answer. Nothing was changed; retry.",
      502,
      { retriable: true }
    );
  const turn: TurnResult = validation.turn;

  // Apply ops (sanitize + injection screen inside).
  const applied = applyOps(documents, turn.docOps, kind);

  // Coverage: the current bank item is covered by answering OR skipping it;
  // additional answered_bank_ids are merged (validated against the bank).
  if (!revise && question.bankId) covered.add(question.bankId);
  for (const bid of turn.answeredBankIds) covered.add(bid);

  const newRev = row.rev + 1;
  const answersIncrement = revise ? 0 : 1;
  const newAnswersCount = row.answersCount + answersIncrement;

  // Host-side review gate: the model's "review" only sticks when required
  // coverage is complete; the 40-answer cap force-flips regardless.
  let status: ProjectStatus;
  let outQuestion: NextQuestion | null = null;
  let reviewSummary: string | null = row.reviewSummary;
  const complete = coverageComplete(kind, covered);
  const forced = !revise && newAnswersCount >= CAPS.answersPerProject;

  if (revise) {
    status = "review";
    reviewSummary = turn.reviewSummary ?? row.reviewSummary;
  } else if (forced) {
    status = "review";
    reviewSummary = turn.reviewSummary ?? REVIEW_FORCED_SUMMARY;
  } else if (turn.status === "review" && complete) {
    status = "review";
    reviewSummary = turn.reviewSummary;
  } else {
    status = "drafting";
    if (turn.question)
      outQuestion = {
        id: `q_${newRev}`,
        bankId: turn.question.bankId,
        text: turn.question.text,
        why: turn.question.why,
        suggestions: turn.question.suggestions,
        feeds: turn.question.bankId
          ? (bankById(kind).get(turn.question.bankId)?.feeds ?? [])
          : [],
      };
    else outQuestion = pickNextBankQuestion(kind, covered, newRev);
    if (!outQuestion) {
      // Bank exhausted with no model question: flip honestly.
      status = "review";
      reviewSummary = turn.reviewSummary ?? REVIEW_FORCED_SUMMARY;
    }
  }

  const now = new Date().toISOString();
  const newTranscript: TranscriptEntry[] = revise
    ? [
        ...transcript,
        {
          qId: "revise",
          bankId: null,
          q: "Revision request",
          a: answer,
          skipped: false,
          askedAt: now,
          answeredAt: now,
        },
      ]
    : [
        ...transcript,
        {
          qId: question.id,
          bankId: question.bankId,
          q: question.text,
          a: skipped ? "" : answer,
          skipped,
          askedAt: row.updatedAt.toISOString(),
          answeredAt: now,
        },
      ];

  const wrote = await applyTurnWrite({
    id: row.id,
    userId: user.userId,
    expectedRev: row.rev,
    status,
    documents: applied.documents,
    transcript: newTranscript,
    coveredBankIds: [...covered],
    nextQuestion: status === "drafting" ? outQuestion : null,
    reviewSummary: status === "review" ? reviewSummary : null,
    changedSections: applied.changedSections,
    flagged: applied.injectionHits.length > 0,
    answersIncrement,
  });
  if (!wrote)
    return govError(
      "stale_question",
      "This question was already answered (maybe in another tab).",
      409
    );

  return okJson({
    rev: newRev,
    status,
    changedSections: applied.changedSections,
    nextQuestion: status === "drafting" ? outQuestion : null,
    reviewSummary: status === "review" ? reviewSummary : null,
    progress: progressFor(kind, covered),
    openConfirmItems: openConfirmItems(applied.documents),
    documents: applied.documents,
  });
}
