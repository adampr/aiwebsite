// Row -> API view mapping (§5.12). JSON columns are parsed defensively (a
// corrupt column degrades to an empty value, never a 500) and the view is the
// single place the client learns about retention dates, progress, and whether
// a queued/stale row is reclaimable (the client then POSTs /research — GETs
// never claim anything).

import type {
  GovernanceDoc,
  GovernanceErrorCode,
  GovernanceKind,
  NextQuestion,
  OpenConfirmItem,
  ProjectStatus,
  ProjectSummary,
  ProjectView,
  ResearchProgress,
  TranscriptEntry,
  TurnState,
} from "./types";
import { bankById, placeholderSectionMap } from "./blueprints";
import { BUILD_ID } from "./build-id";
import { CAPS, governanceEnabled } from "./config";
import {
  attachItemGuesses,
  hydrateChaseSuggestions,
  parseGuessStore,
} from "./guesses";
import { countConfirmMarkers, scanConfirmMarkers } from "./markdown";
import { detectNumberingStyle } from "./numbering";
import { sampleOutlineTopTitles, sampleVerbosity } from "./prompt";
import { normalizeBrief } from "./research";
import { progressFor } from "./turn";
import type { ProjectRow } from "./db";
import { deletesAt } from "./db";

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const STALE_HEARTBEAT_MS = 5 * 60_000;

function isReclaimable(row: ProjectRow): boolean {
  if (row.status === "queued") return true;
  if (row.status === "researching") {
    const hb = row.researchHeartbeatAt?.getTime() ?? 0;
    return Date.now() - hb > STALE_HEARTBEAT_MS;
  }
  return false;
}

/**
 * Async answer-turn state for the poll (§5.12), derived read-only. Exported
 * with an injectable clock for scripts/governance-tests. A running claim
 * past the staleness horizon was orphaned (restart mid-turn): it is
 * PRESENTED as a transport failure — same copy the client shows for a
 * dropped connection — and physically reaped by the next POST claim.
 */
export function deriveTurnState(
  cols: {
    turnPromptId: string | null;
    turnStartedAt: Date | null;
    turnJson: string | null;
  },
  now: number
): TurnState | null {
  if (!cols.turnPromptId) return null;
  const rec = parseJson<{
    questionId?: unknown;
    error?: { code?: unknown; message?: unknown; retriable?: unknown };
  }>(cols.turnJson, {});
  const questionId = typeof rec.questionId === "string" ? rec.questionId : "";
  if (cols.turnStartedAt) {
    if (now - cols.turnStartedAt.getTime() < CAPS.turnStaleMs)
      return {
        phase: "running",
        promptId: cols.turnPromptId,
        questionId,
        startedAt: cols.turnStartedAt.toISOString(),
      };
    return {
      phase: "failed",
      promptId: cols.turnPromptId,
      questionId,
      error: {
        code: "network",
        message:
          "That did not go through. Your answer is still here; send it again.",
        retriable: true,
      },
    };
  }
  if (
    typeof rec.error?.code !== "string" ||
    typeof rec.error?.message !== "string"
  )
    return null;
  return {
    phase: "failed",
    promptId: cols.turnPromptId,
    questionId,
    error: {
      code: rec.error.code as GovernanceErrorCode | "network",
      message: rec.error.message,
      ...(rec.error.retriable === true ? { retriable: true } : {}),
    },
  };
}

/** Word-boundary cap for snapshot fields (truncate idiom from the UI). */
function capField(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max / 2 ? cut.slice(0, sp) : cut) + "...";
}

/**
 * Tron's research understanding, capped for the question card's snapshot
 * block (§5.12): the object of review on background-check questions. Null
 * when the brief is null or carries none of the display fields (the
 * partial-start emptyBrief has distilledAt set but empty fields — that
 * reduction is load-bearing, or the card would render an empty frame).
 */
export function composeCompanySnapshot(
  brief: ReturnType<typeof normalizeBrief>
): ProjectView["companySnapshot"] {
  if (!brief) return null;
  const name = capField(brief.companyName ?? "", 80);
  const profile = capField(brief.companyProfile ?? "", 280);
  const size = capField(brief.sizeAndFootprint ?? "", 140);
  const industry = capField(brief.industryContext ?? "", 140);
  if (!profile && !size && !industry && !name) return null;
  return { name, profile, size, industry };
}

export function openConfirmItems(
  documents: GovernanceDoc[]
): OpenConfirmItem[] {
  const out: OpenConfirmItem[] = [];
  for (const d of documents)
    for (const s of d.sections)
      for (const m of scanConfirmMarkers(s.markdown))
        out.push({ doc: d.slug, section: s.id, ...m });
  return out.slice(0, 50);
}

/** TRUE open-marker total (lenient scan; counts markers the item list cannot
 *  parse). The confirm gate and every user-facing count use this. */
export function openConfirmTotal(documents: GovernanceDoc[]): number {
  let n = 0;
  for (const d of documents)
    for (const s of d.sections) n += countConfirmMarkers(s.markdown);
  return n;
}

export function toProjectView(row: ProjectRow): ProjectView {
  const kind = row.kind as GovernanceKind;
  const documents = parseJson<GovernanceDoc[]>(row.documentsJson, []);
  const covered = new Set(parseJson<string[]>(row.coveredBankIdsJson, []));
  const rawNextQuestion = parseJson<NextQuestion | null>(
    row.nextQuestionJson,
    null
  );
  // Rows written before questions carried feeds normalize to []. The
  // snapshot flag is DERIVED from the blueprint here (single source of
  // truth, never persisted): a stored Q1 from before the flag existed
  // still gets the research-snapshot treatment. A chip-less chase question
  // is re-hydrated from the guess store (idempotent with the runner's own
  // hydration; covers qi_ questions stored before a guess arrived).
  const guessStore = parseGuessStore(row.openItemGuessesJson);
  const nextQuestion = rawNextQuestion
    ? hydrateChaseSuggestions(
        {
          ...rawNextQuestion,
          feeds: rawNextQuestion.feeds ?? [],
          suggestions: rawNextQuestion.suggestions ?? [],
          snapshot: rawNextQuestion.bankId
            ? bankById(kind).get(rawNextQuestion.bankId)?.snapshot === true
            : false,
        },
        documents,
        guessStore
      )
    : null;
  const researchProgress = parseJson<ResearchProgress | null>(
    row.researchProgressJson,
    null
  );
  return {
    id: row.id,
    kind,
    domain: row.domain,
    status: row.status as ProjectStatus,
    rev: row.rev,
    documents,
    transcript: parseJson<TranscriptEntry[]>(row.transcriptJson, []),
    nextQuestion,
    reviewSummary: row.reviewSummary,
    changedSections: parseJson<Record<string, string[]>>(
      row.changedSectionsJson,
      {}
    ),
    placeholderSections: placeholderSectionMap(kind, documents),
    progress: progressFor(kind, covered),
    researchProgress: researchProgress
      ? {
          step: researchProgress.step,
          pct: researchProgress.pct,
          counts: researchProgress.counts,
          ...(researchProgress.error ? { error: researchProgress.error } : {}),
        }
      : null,
    openConfirmItems: attachItemGuesses(
      openConfirmItems(documents),
      documents,
      guessStore
    ),
    openConfirmTotal: openConfirmTotal(documents),
    companySnapshot: composeCompanySnapshot(
      normalizeBrief(parseJson<unknown>(row.researchJson, null))
    ),
    styleSample: row.styleSampleName
      ? {
          name: row.styleSampleName,
          // Derived per view (linear over <=20k chars), never persisted:
          // rows uploaded before round 15b adopt their style on next load.
          numbering: row.styleSampleText
            ? detectNumberingStyle(row.styleSampleText)
            : null,
          // Round 16: boolean only; the debt token itself never leaves the
          // server (it fences the run worker's clear against replacements).
          reformatDebt: row.styleSampleDebt !== null,
          // Round 17: the stored letterhead for the control's preview
          // (null = pre-capture legacy sample; "" = scanned, none found).
          letterhead:
            row.styleSampleHeader !== null || row.styleSampleFooter !== null
              ? {
                  header: row.styleSampleHeader ?? "",
                  footer: row.styleSampleFooter ?? "",
                }
              : null,
          // Round 18b: derived per view like numbering, never persisted.
          outlineTitles: row.styleSampleText
            ? sampleOutlineTopTitles(row.styleSampleText)
            : [],
          // Round 17: derived per view like numbering, never persisted.
          verbosity: (() => {
            const v = row.styleSampleText
              ? sampleVerbosity(row.styleSampleText)
              : null;
            return v ? { band: v.band, targetWords: v.targetWords } : null;
          })(),
        }
      : null,
    answersCount: row.answersCount,
    deletesAt: deletesAt(row.lastActivityAt),
    createdAt: row.createdAt.toISOString(),
    reclaimable: isReclaimable(row),
    turn: deriveTurnState(row, Date.now()),
    featureDisabled: !governanceEnabled(process.env),
    serverBuildId: BUILD_ID,
  };
}

export function toProjectSummary(row: ProjectRow): ProjectSummary {
  const kind = row.kind as GovernanceKind;
  const covered = new Set(parseJson<string[]>(row.coveredBankIdsJson, []));
  return {
    id: row.id,
    kind,
    domain: row.domain,
    status: row.status as ProjectStatus,
    rev: row.rev,
    answersCount: row.answersCount,
    progress: progressFor(kind, covered),
    deletesAt: deletesAt(row.lastActivityAt),
    createdAt: row.createdAt.toISOString(),
  };
}
