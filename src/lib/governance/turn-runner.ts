// One answer/revise turn, claim to final write (§5.12 async turn). The
// pipeline the answer route used to run inline: brain JSON turn -> parse ->
// at most one repair call -> server-gated apply in ONE rev+fence-conditional
// write. Runs in-process (Next after()) with no route deadline. Every exit
// path either applies the turn (which clears the claim) or records a
// failure via failTurn (which releases it) — a throw here must never leave
// a running claim to age out.

import {
  buildGovernanceEnvelope,
  callGovernanceBrain,
  newId,
} from "./brain";
import { CAPS, REVIEW_FORCED_SUMMARY } from "./config";
import { effectiveBrainDailyCap } from "./budget";
import { applyTurnWrite, failTurn, type ProjectRow, trySpendBudget } from "./db";
import {
  buildSystemMessage,
  buildTurnUserMessage,
  repairSystemMessage,
} from "./prompt";
import {
  applyOps,
  coverageComplete,
  parseTurnJson,
  pickNextBankQuestion,
  progressFor,
  validateTurn,
} from "./turn";
import { bankById, placeholderSectionMap } from "./blueprints";
import { normalizeBrief } from "./research";
import { openConfirmItems, openConfirmTotal } from "./view";
import type {
  GovernanceDoc,
  GovernanceErrorCode,
  GovernanceKind,
  NextQuestion,
  OpenConfirmItem,
  ProjectStatus,
  ResearchBrief,
  TranscriptEntry,
  TurnResult,
} from "./types";

export interface TurnJob {
  row: ProjectRow; // the pre-claim fetch; rev is the claim's expectedRev
  userId: string;
  questionId: string;
  answer: string; // trimmed; "" when skipped
  skipped: boolean;
  revise: boolean;
  // Open-item resolver batches (§5.12): "slug#section" pairs the revision
  // targets; validated against the docs here, then serialized verbatim in
  // the prompt (an elided section cannot be edited by the model).
  focusSections: string[];
  promptId: string;
  attemptId: string; // claim fence nonce
  budgetExempt: boolean; // captured at accept for the repair spend
}

export interface TurnResponseBody {
  rev: number;
  status: ProjectStatus;
  changedSections: Record<string, string[]>;
  placeholderSections: Record<string, string[]>;
  nextQuestion: NextQuestion | null;
  reviewSummary: string | null;
  progress: { answered: number; total: number };
  openConfirmItems: OpenConfirmItem[];
  openConfirmTotal: number;
  documents: GovernanceDoc[];
}

export type TurnOutcome =
  | { ok: true; body: TurnResponseBody }
  | {
      ok: false;
      code: GovernanceErrorCode;
      message: string;
      status: number;
      retriable?: boolean;
    };

function parse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Run one claimed turn to completion. Always resolves (never throws): the
 * outcome is also persisted on the row — applyTurnWrite on success, failTurn
 * on every failure — so the poll can surface it after the caller is gone.
 */
export async function runTurn(job: TurnJob): Promise<TurnOutcome> {
  try {
    return await runTurnInner(job);
  } catch {
    const out = {
      ok: false as const,
      code: "invalid_turn" as const,
      message: "Tron hit a snag applying that answer. Nothing was changed; retry.",
      status: 502,
      retriable: true,
    };
    await failTurn(job.row.id, job.attemptId, {
      code: out.code,
      message: out.message,
      retriable: true,
    }).catch(() => undefined);
    return out;
  }
}

async function runTurnInner(job: TurnJob): Promise<TurnOutcome> {
  const started = Date.now();
  const fail = async (
    code: GovernanceErrorCode,
    message: string,
    status: number,
    retriable?: boolean
  ): Promise<TurnOutcome> => {
    await failTurn(job.row.id, job.attemptId, {
      code,
      message,
      ...(retriable !== undefined ? { retriable } : {}),
    });
    return { ok: false, code, message, status, retriable };
  };

  const { row, questionId, answer, skipped, revise } = job;
  const kind = row.kind as GovernanceKind;

  // Assemble the turn (identical to the old inline route logic).
  const documents = parse<GovernanceDoc[]>(row.documentsJson, []);
  const transcript = parse<TranscriptEntry[]>(row.transcriptJson, []);
  const covered = new Set(parse<string[]>(row.coveredBankIdsJson, []));
  const brief: ResearchBrief | null = normalizeBrief(
    parse<unknown>(row.researchJson, null)
  );
  const changedSections = parse<Record<string, string[]> | null>(
    row.changedSectionsJson,
    null
  );
  const nextQuestion = parse<NextQuestion | null>(row.nextQuestionJson, null);
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
  const validFocusRefs = revise
    ? job.focusSections.filter((f) => {
        const i = f.indexOf("#");
        if (i <= 0 || i >= f.length - 1) return false;
        const d = documents.find((x) => x.slug === f.slice(0, i));
        return !!d && d.sections.some((s) => s.id === f.slice(i + 1));
      })
    : [];
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
    focusRefs: validFocusRefs,
  });

  const sessionId = `gov_${row.id}`;
  const raw = await callGovernanceBrain(
    buildGovernanceEnvelope({
      sessionId,
      promptId: job.promptId,
      system,
      user: userMsg,
    }),
    CAPS.brainTurnTimeoutMs
  );
  if (raw === null)
    return fail(
      "brain_unavailable",
      "Tron's drafting engine did not answer. Your answer is kept below; try again in a moment.",
      503,
      true
    );

  // Parse -> validate -> at most ONE repair call (new promptId, never reuse
  // the original: the brain replays (sessionId,promptId) verbatim).
  let validation = validateTurn(parseTurnJson(raw), kind);
  // Full repair budget as long as the staleness horizon leaves headroom
  // for the call plus the final write (it always does after a 90 s brain
  // call; the guard protects against pathological semaphore waits).
  const repairBudgetMs =
    CAPS.turnStaleMs - (Date.now() - started) > 80_000 ? 60_000 : 0;
  if (!validation.ok && repairBudgetMs > 0) {
    if (
      job.budgetExempt ||
      (await trySpendBudget("brain_calls", 1, await effectiveBrainDailyCap()))
    ) {
      const repairRaw = await callGovernanceBrain(
        buildGovernanceEnvelope({
          sessionId,
          promptId: newId("gov"),
          system: repairSystemMessage(),
          user: `Validation errors:\n${validation.errors.join("\n")}\n\nRaw output to repair:\n${raw.slice(0, 32_000)}`,
        }),
        repairBudgetMs
      );
      if (repairRaw) validation = validateTurn(parseTurnJson(repairRaw), kind);
    }
  }
  if (!validation.ok || !validation.turn)
    return fail(
      "invalid_turn",
      "Tron hit a snag applying that answer. Nothing was changed; retry.",
      502,
      true
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
    userId: job.userId,
    expectedRev: row.rev,
    attemptId: job.attemptId,
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
    return fail(
      "stale_question",
      "This question was already answered (maybe in another tab).",
      409
    );

  return {
    ok: true,
    body: {
      rev: newRev,
      status,
      changedSections: applied.changedSections,
      // Rides every turn (like changedSections) so Planned chips clear in the
      // same render that draws the Updated chip; there is no idle poll in
      // drafting to correct a stale map later.
      placeholderSections: placeholderSectionMap(kind, applied.documents),
      nextQuestion: status === "drafting" ? outQuestion : null,
      reviewSummary: status === "review" ? reviewSummary : null,
      progress: progressFor(kind, covered),
      openConfirmItems: openConfirmItems(applied.documents),
      openConfirmTotal: openConfirmTotal(applied.documents),
      documents: applied.documents,
    },
  };
}
