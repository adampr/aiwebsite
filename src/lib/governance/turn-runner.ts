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
import { CAPS, REVIEW_SKIPPED_SUMMARY, withOpenItemsNote } from "./config";
import { effectiveBrainDailyCap, notifyBudgetHit } from "./budget";
import { applyTurnWrite, failTurn, type ProjectRow, trySpendBudget } from "./db";
import {
  buildAmendUserMessage,
  buildRestyleUserMessage,
  buildSystemMessage,
  buildGuessBackfillUserMessage,
  buildTurnUserMessage,
  guessBackfillSystemMessage,
  repairSystemMessage,
  sampleBucketTitles,
} from "./prompt";
import {
  applyOps,
  coverageComplete,
  parseBackfillGuesses,
  parseTurnJson,
  progressFor,
  resolveNonAdvancingGate,
  resolveTurnGate,
  validateTurn,
} from "./turn";
import { isQuestionEntry } from "./interview";
import {
  attachItemGuesses,
  deriveDeterministicGuesses,
  guessGapMarkers,
  guessKey,
  hydrateChaseSuggestions,
  mergeOpenItemGuesses,
  parseGuessStore,
} from "./guesses";
import { countConfirmMarkers, findConfirmMarkers } from "./markdown";
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

/** What kind of turn this is (§5.12). "answer" and "revise" advance the
 * interview; "restyle" (format-sample pass) and "amend" (correct an earlier
 * answer) are NON-ADVANCING: they never consume the pending question, never
 * change bank coverage, never increment answersCount, and preserve status
 * via resolveNonAdvancingGate. */
export type TurnKind = "answer" | "revise" | "restyle" | "amend";

export interface TurnJob {
  row: ProjectRow; // the pre-claim fetch; rev is the claim's expectedRev
  userId: string;
  questionId: string;
  answer: string; // trimmed; "" when skipped
  skipped: boolean;
  kind: TurnKind;
  // Open-item resolver batches and restyle batches (§5.12): "slug#section"
  // pairs the turn's targets; validated against the docs here, then
  // serialized verbatim in the prompt (an elided section cannot be edited
  // by the model).
  focusSections: string[];
  // Restyle turns only (round 16): the client asserts this batch empties its
  // pending refs; the success write then clears reformat debt. The clear is
  // token-fenced in db.ts, so a stale assertion cannot touch a newer sample.
  restyleFinal?: boolean;
  // Amend turns only: index of the transcript entry being corrected.
  amendIndex?: number;
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
  } catch (err) {
    // Round-8 lesson, kept: a swallowed error string is a prod incident
    // with no diagnosis path. Log the stack; never log answer content.
    console.error(
      `[governance] turn crashed project=${job.row.id} rev=${job.row.rev} q=${job.questionId}:`,
      err instanceof Error ? err.stack : err
    );
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

  const { row, questionId, answer, skipped } = job;
  const revise = job.kind === "revise";
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

  const sessionId = `gov_${row.id}`;
  /** One brain call, parse, and at most ONE budget-counted repair call. */
  const callValidated = async (
    system: string,
    user: string,
    opts: { nonAdvancing?: boolean }
  ): Promise<TurnResult | "brain_down" | "invalid"> => {
    const raw = await callGovernanceBrain(
      buildGovernanceEnvelope({
        sessionId,
        promptId: job.promptId,
        system,
        user,
      }),
      CAPS.brainTurnTimeoutMs
    );
    if (raw === null) return "brain_down";
    let validation = validateTurn(parseTurnJson(raw), kind, opts);
    if (!validation.ok)
      console.error(
        `[governance] turn invalid project=${row.id} rev=${row.rev} q=${questionId} raw=${raw.length}ch errors: ${validation.errors.join("; ").slice(0, 600)}`
      );
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
        if (repairRaw)
          validation = validateTurn(parseTurnJson(repairRaw), kind, opts);
      }
    }
    if (!validation.ok || !validation.turn) {
      console.error(
        `[governance] turn failed after repair project=${row.id} rev=${row.rev} q=${questionId} errors: ${validation.errors.join("; ").slice(0, 600)}`
      );
      return "invalid";
    }
    return validation.turn;
  };

  if (job.kind === "restyle") return runRestyle();
  if (job.kind === "amend") return runAmend();

  const question: NextQuestion = revise
    ? {
        id: "revise",
        bankId: null,
        text: "Revision request",
        why: "",
        suggestions: [],
        feeds: [],
      }
    : // Pre-feeds rows normalize to [] (view.ts parity): the prompt's focus
      // fold iterates feeds and must never throw on an old row.
      { ...nextQuestion!, feeds: nextQuestion!.feeds ?? [] };

  // Owner rule 2026-07-17: skipping an open-item chase question ("qi_" id)
  // is the user's explicit exit to review. Deterministic host flip: no
  // brain call, no doc ops; the review panel keeps the open items for
  // resolution and confirm still refuses while any remain.
  if (!revise && skipped && questionId.startsWith("qi_")) {
    const openTotal = openConfirmTotal(documents);
    const summary = withOpenItemsNote(REVIEW_SKIPPED_SUMMARY, openTotal);
    const nowIso = new Date().toISOString();
    const wrote = await applyTurnWrite({
      id: row.id,
      userId: job.userId,
      expectedRev: row.rev,
      attemptId: job.attemptId,
      status: "review",
      documents,
      transcript: [
        ...transcript,
        {
          qId: question.id,
          bankId: null,
          q: question.text,
          a: "",
          skipped: true,
          askedAt: row.updatedAt.toISOString(),
          answeredAt: nowIso,
        },
      ],
      coveredBankIds: [...covered],
      nextQuestion: null,
      reviewSummary: summary,
      changedSections: {},
      flagged: false,
      answersIncrement: 1,
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
        rev: row.rev + 1,
        status: "review",
        changedSections: {},
        placeholderSections: placeholderSectionMap(kind, documents),
        nextQuestion: null,
        reviewSummary: summary,
        progress: progressFor(kind, covered),
        // The skip write leaves the guess column untouched; the resolver
        // that opens right after still gets the stored best guesses.
        openConfirmItems: attachItemGuesses(
          openConfirmItems(documents),
          documents,
          parseGuessStore(row.openItemGuessesJson)
        ),
        openConfirmTotal: openTotal,
        documents,
      },
    };
  }

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

  const outcome = await callValidated(system, userMsg, {});
  if (outcome === "brain_down")
    return fail(
      "brain_unavailable",
      "Tron's drafting engine did not answer. Your answer is kept below; try again in a moment.",
      503,
      true
    );
  if (outcome === "invalid")
    return fail(
      "invalid_turn",
      "Tron hit a snag applying that answer. Nothing was changed; retry.",
      502,
      true
    );
  const turn: TurnResult = outcome;

  // Apply ops (sanitize + injection screen inside).
  const applied = applyOps(documents, turn.docOps, kind, {
    bucketTitles: row.styleSampleText
      ? sampleBucketTitles(row.styleSampleText)
      : null,
  });

  // Coverage: the current bank item is covered by answering OR skipping it;
  // additional answered_bank_ids are merged (validated against the bank).
  if (!revise && question.bankId) covered.add(question.bankId);
  for (const bid of turn.answeredBankIds) covered.add(bid);

  const newRev = row.rev + 1;
  const answersIncrement = revise ? 0 : 1;
  const newAnswersCount = row.answersCount + answersIncrement;

  // Host-side review gate (owner rule 2026-07-17, resolveTurnGate): the
  // voluntary drafting->review flip requires required coverage AND zero open
  // [TO CONFIRM] markers; while markers remain the host chases them with
  // normal questions. Forced flips carry the honest open-items note.
  const complete = coverageComplete(kind, covered);
  const forced = !revise && newAnswersCount >= CAPS.answersPerProject;
  const openTotal = openConfirmTotal(applied.documents);
  const gate = resolveTurnGate({
    kind,
    revise,
    forced,
    complete,
    openTotal,
    documents: applied.documents,
    covered,
    turn,
    priorSummary: row.reviewSummary,
    newRev,
  });
  const status: ProjectStatus = gate.status;
  const reviewSummary: string | null = gate.reviewSummary;

  // Marker best-guess store (§5.12): this turn's emissions win, surviving
  // markers carry their prior guesses forward, dead keys prune. Stored in
  // its own cold column, so it can never tip documentsJson over its byte
  // cap. Hydration fills a chase question's chips from the store here (the
  // POST body) exactly as view.ts does for the poll.
  let guessStore = mergeOpenItemGuesses(
    parseGuessStore(row.openItemGuessesJson),
    turn.openItemGuesses,
    applied.documents
  );

  // Guess backfill (§5.12 round 2, owner-authorized extra AI call): when
  // this turn will present open items whose markers have neither a
  // deterministic draft-derived guess nor a stored one, ONE budget-counted
  // call fills the gap BEFORE the fenced write (there is no idle poll in
  // drafting; anything written later misses the screen until the next
  // turn). The Promise.race deadline covers the brain SEMAPHORE WAIT, not
  // just the HTTP call: an unbounded acquire under load must never push
  // this worker past turnStaleMs, or a reclaimer voids the fenced write
  // and the user's applied answer is lost. Failure of any kind degrades to
  // no chips; the turn itself never fails here.
  const presentsOpen =
    (gate.status === "review" && openTotal > 0) ||
    gate.outQuestion?.id.startsWith("qi_") === true;
  if (presentsOpen) {
    const det = deriveDeterministicGuesses(applied.documents);
    const gap = guessGapMarkers(applied.documents, det, guessStore);
    const headroom = CAPS.turnStaleMs - (Date.now() - started);
    if (gap.length && headroom > CAPS.backfillMinHeadroomMs) {
      if (
        job.budgetExempt ||
        (await trySpendBudget("brain_calls", 1, await effectiveBrainDailyCap()))
      ) {
        const raw = await Promise.race([
          callGovernanceBrain(
            buildGovernanceEnvelope({
              sessionId,
              promptId: newId("gov"),
              system: guessBackfillSystemMessage(),
              user: buildGuessBackfillUserMessage({
                documents: applied.documents,
                brief,
                markers: gap,
              }),
            }),
            CAPS.backfillTimeoutMs
          ),
          new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), CAPS.backfillTimeoutMs)
          ),
        ]);
        // Gap-only merge: backfill can never clobber an existing guess.
        const fill = raw
          ? parseBackfillGuesses(raw).filter(
              (e) => !(guessKey(e.excerpt) in guessStore)
            )
          : [];
        if (fill.length)
          guessStore = mergeOpenItemGuesses(guessStore, fill, applied.documents);
        else
          console.error(
            `[governance] guess backfill ${raw ? "empty" : "no response"} project=${row.id} markers=${gap.length}`
          );
      } else {
        void notifyBudgetHit("global_brain", { operation: "guess backfill" });
      }
    }
  }

  const outQuestion: NextQuestion | null = gate.outQuestion
    ? hydrateChaseSuggestions(gate.outQuestion, applied.documents, guessStore)
    : null;

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
          // Kept so a later amend of this answer can serialize the right
          // sections verbatim (§5.12 amend focus).
          feeds: question.feeds,
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
    openItemGuesses: guessStore,
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
      openConfirmItems: attachItemGuesses(
        openConfirmItems(applied.documents),
        applied.documents,
        guessStore
      ),
      openConfirmTotal: openTotal,
      documents: applied.documents,
    },
  };

  /** Shared tail for non-advancing turns: gate, transcript entry, fenced
   *  write with answersIncrement 0, and the response body. */
  async function finishNonAdvancing(
    turnKind: "restyle" | "amend",
    appliedDocs: GovernanceDoc[],
    appliedChanged: Record<string, string[]>,
    flagged: boolean,
    turnSummary: string | null,
    entry: TranscriptEntry,
    // Amend turns pass their open_item_guesses (a corrected fact can change
    // what the model would guess); restyle passes [] (markers are preserved
    // character for character, so stored guesses stay valid and just carry
    // forward through the merge's prune).
    emittedGuesses: { excerpt: string; guesses: string[] }[]
  ): Promise<TurnOutcome> {
    const newRev = row.rev + 1;
    const openTotal = openConfirmTotal(appliedDocs);
    const gate = resolveNonAdvancingGate({
      kind,
      turnKind,
      status: row.status as "drafting" | "review",
      storedQuestion: nextQuestion,
      documents: appliedDocs,
      openTotal,
      covered,
      turnSummary,
      priorSummary: row.reviewSummary,
      newRev,
    });
    const guessStore = mergeOpenItemGuesses(
      parseGuessStore(row.openItemGuessesJson),
      emittedGuesses,
      appliedDocs
    );
    const outQ = gate.outQuestion
      ? hydrateChaseSuggestions(gate.outQuestion, appliedDocs, guessStore)
      : null;
    const wrote = await applyTurnWrite({
      id: row.id,
      userId: job.userId,
      expectedRev: row.rev,
      attemptId: job.attemptId,
      status: gate.status,
      documents: appliedDocs,
      transcript: [...transcript, entry],
      coveredBankIds: [...covered],
      nextQuestion: gate.status === "drafting" ? outQ : null,
      reviewSummary: gate.status === "review" ? gate.reviewSummary : null,
      changedSections: appliedChanged,
      flagged,
      answersIncrement: 0,
      // Round 16: the run's FINAL pass clears reformat debt in the same
      // fenced write that applies it. row is the pre-claim fetch, so this is
      // the token the worker reformatted toward; a replacement uploaded
      // mid-turn holds a different token and keeps its debt (CASE in db.ts).
      clearStyleDebtToken:
        turnKind === "restyle" && job.restyleFinal
          ? (row.styleSampleDebt ?? null)
          : null,
      openItemGuesses: guessStore,
    });
    if (!wrote)
      return fail(
        "stale_question",
        "The draft moved before this landed (maybe in another tab). Nothing was changed; try again.",
        409
      );
    return {
      ok: true,
      body: {
        rev: newRev,
        status: gate.status,
        changedSections: appliedChanged,
        placeholderSections: placeholderSectionMap(kind, appliedDocs),
        nextQuestion: gate.status === "drafting" ? outQ : null,
        reviewSummary: gate.status === "review" ? gate.reviewSummary : null,
        progress: progressFor(kind, covered),
        openConfirmItems: attachItemGuesses(
          openConfirmItems(appliedDocs),
          appliedDocs,
          guessStore
        ),
        openConfirmTotal: openTotal,
        documents: appliedDocs,
      },
    };
  }

  /** Restyle turn (§5.12): reformat one batch of drafted sections to the
   *  format sample. Non-advancing; the server re-derives the safe target
   *  set itself (placeholder and stub sections NEVER restyle: a reworded
   *  scaffold would stop byte-matching the placeholder detector and launder
   *  undrafted text past the confirm gate), op-filters the response to the
   *  batch, and hard-gates marker preservation (count AND excerpt sequence
   *  per touched section: a reworded marker would orphan resolver rows and
   *  stale the chase question). */
  async function runRestyle(): Promise<TurnOutcome> {
    if (!row.styleSampleText)
      return fail(
        "invalid_request",
        "Attach a format sample first, then apply it.",
        409
      );
    const placeholders = placeholderSectionMap(kind, documents);
    const refs = job.focusSections.filter((f) => {
      const i = f.indexOf("#");
      if (i <= 0 || i >= f.length - 1) return false;
      const slug = f.slice(0, i);
      const sid = f.slice(i + 1);
      const d = documents.find((x) => x.slug === slug);
      if (!d || d.stub) return false;
      if (!d.sections.some((s) => s.id === sid)) return false;
      return !(placeholders[slug] ?? []).includes(sid);
    });
    if (!refs.length)
      return fail(
        "invalid_turn",
        "Nothing in that batch can be reformatted. The draft is unchanged.",
        409
      );
    const system = buildSystemMessage({
      kind,
      brief,
      forcedReviewSoon: false,
      styleSample: {
        name: row.styleSampleName ?? "sample",
        text: row.styleSampleText,
      },
      restyle: true,
    });
    const out = await callValidated(
      system,
      buildRestyleUserMessage({
        kind,
        documents,
        focusRefs: refs,
        adoptTitles: sampleBucketTitles(row.styleSampleText),
      }),
      { nonAdvancing: true }
    );
    if (out === "brain_down")
      return fail(
        "brain_unavailable",
        "Tron's drafting engine did not answer. The draft is unchanged; try again in a moment.",
        503,
        true
      );
    if (out === "invalid")
      return fail(
        "invalid_turn",
        "Tron could not apply the format this pass. Nothing was changed; try again.",
        502,
        true
      );
    const refSet = new Set(refs);
    // Structure adoption (§5.12): a reorder op is doc-global (section ids
    // stay stable, host numbering renumbers on render), so it is allowed for
    // any doc with a section in this batch — at most one per doc, first
    // wins. applyOps enforces the exact-permutation invariant.
    const batchDocs = new Set(refs.map((r) => r.slice(0, r.indexOf("#"))));
    const reordered = new Set<string>();
    const adopted = new Set<string>();
    const ops = out.docOps.filter((op) => {
      if (op.op === "upsert_section")
        return refSet.has(`${op.doc}#${op.section}`);
      if (op.op === "reorder_sections" && batchDocs.has(op.doc)) {
        if (reordered.has(op.doc)) return false;
        reordered.add(op.doc);
        return true;
      }
      // Skeleton adoption (round 18b): doc-global like reorder, at most one
      // per doc, never for stub docs (a determination must lead a stub, not
      // sit inside a template bucket). applyOps enforces the exact
      // partition; a non-partition proposal is dropped there, whole.
      if (op.op === "adopt_outline" && batchDocs.has(op.doc)) {
        if (adopted.has(op.doc)) return false;
        if (documents.find((d) => d.slug === op.doc)?.stub) return false;
        adopted.add(op.doc);
        return true;
      }
      return false;
    });
    if (!ops.length) {
      // A VALIDATED response with no applicable ops is a legitimate outcome:
      // the batch already matches the sample (common right after a re-upload
      // of the same document). Failing here would wedge the run: the final
      // pass could never land, so reformat debt would never clear and the
      // user would loop on "try again" over a matching draft (critic
      // amendment, round 16). Land it as a no-change pass: rev bump, claim
      // clear, and the token clear when this batch was the final one.
      const nowIso = new Date().toISOString();
      return finishNonAdvancing(
        "restyle",
        documents,
        {},
        false,
        out.reviewSummary,
        {
          qId: "restyle",
          bankId: null,
          q: "Format pass",
          a: "No format changes were needed in this batch.",
          skipped: false,
          askedAt: nowIso,
          answeredAt: nowIso,
        },
        []
      );
    }
    const applied = applyOps(documents, ops, kind, {
      bucketTitles: row.styleSampleText
        ? sampleBucketTitles(row.styleSampleText)
        : null,
    });
    for (const [slug, secs] of Object.entries(applied.changedSections)) {
      const bd = documents.find((d) => d.slug === slug);
      const ad = applied.documents.find((d) => d.slug === slug);
      for (const sid of secs) {
        const bmd = bd?.sections.find((s) => s.id === sid)?.markdown ?? "";
        const amd = ad?.sections.find((s) => s.id === sid)?.markdown ?? "";
        const parity =
          countConfirmMarkers(bmd) === countConfirmMarkers(amd) &&
          JSON.stringify(findConfirmMarkers(bmd)) ===
            JSON.stringify(findConfirmMarkers(amd));
        if (!parity)
          return fail(
            "invalid_turn",
            "That format pass tried to change an open item, so it was rejected. The draft is unchanged; try again.",
            502,
            true
          );
      }
    }
    const titles: string[] = [];
    for (const [slug, secs] of Object.entries(applied.changedSections)) {
      const d = applied.documents.find((x) => x.slug === slug);
      for (const sid of secs) {
        const t = d?.sections.find((s) => s.id === sid)?.title;
        if (t) titles.push(t);
      }
    }
    const nowIso = new Date().toISOString();
    return finishNonAdvancing(
      "restyle",
      applied.documents,
      applied.changedSections,
      applied.injectionHits.length > 0,
      out.reviewSummary,
      {
        qId: "restyle",
        bankId: null,
        q: "Format pass",
        a: `Applied the format sample to: ${titles.join(", ").slice(0, 300)}`,
        skipped: false,
        askedAt: nowIso,
        answeredAt: nowIso,
      },
      []
    );
  }

  /** Amend turn (§5.12): the user corrected an earlier answer. Non-advancing;
   *  the pending question is host-preserved and bank coverage is untouched.
   *  Focus comes from the original entry's stored feeds (new rows carry
   *  them), falling back to the bank feeds for legacy rows. */
  async function runAmend(): Promise<TurnOutcome> {
    const idx = job.amendIndex ?? -1;
    const orig = transcript[idx];
    if (!orig || !isQuestionEntry(orig))
      return fail(
        "invalid_request",
        "That answer can no longer be changed.",
        400
      );
    const rawFeeds =
      orig.feeds && orig.feeds.length
        ? orig.feeds
        : orig.bankId
          ? (bankById(kind).get(orig.bankId)?.feeds ?? [])
          : [];
    const focusRefs = rawFeeds.filter((f) => {
      const i = f.indexOf("#");
      if (i <= 0 || i >= f.length - 1) return false;
      const d = documents.find((x) => x.slug === f.slice(0, i));
      return !!d && d.sections.some((s) => s.id === f.slice(i + 1));
    });
    const inReview = row.status === "review";
    const system = buildSystemMessage({
      kind,
      brief,
      forcedReviewSoon: false,
      styleSample: row.styleSampleText
        ? { name: row.styleSampleName ?? "sample", text: row.styleSampleText }
        : null,
    });
    const out = await callValidated(
      system,
      buildAmendUserMessage({
        kind,
        documents,
        transcript,
        original: orig,
        answer,
        changedSections,
        inReview,
        focusRefs,
      }),
      { nonAdvancing: true }
    );
    if (out === "brain_down")
      return fail(
        "brain_unavailable",
        "Tron's drafting engine did not answer. Your new answer is kept; try again in a moment.",
        503,
        true
      );
    if (out === "invalid")
      return fail(
        "invalid_turn",
        "Tron hit a snag applying that change. Nothing was changed; retry.",
        502,
        true
      );
    const applied = applyOps(documents, out.docOps, kind, {
      bucketTitles: row.styleSampleText
        ? sampleBucketTitles(row.styleSampleText)
        : null,
    });
    const nowIso = new Date().toISOString();
    return finishNonAdvancing(
      "amend",
      applied.documents,
      applied.changedSections,
      applied.injectionHits.length > 0,
      out.reviewSummary,
      {
        qId: "amend",
        bankId: orig.bankId,
        q: orig.q,
        a: answer,
        skipped: false,
        askedAt: nowIso,
        answeredAt: nowIso,
        amendsIndex: idx,
        feeds: focusRefs,
      },
      out.openItemGuesses
    );
  }
}
