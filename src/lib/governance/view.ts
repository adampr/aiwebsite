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
import { placeholderSectionMap } from "./blueprints";
import { CAPS, governanceEnabled } from "./config";
import { countConfirmMarkers, scanConfirmMarkers } from "./markdown";
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
  // Rows written before questions carried feeds normalize to [].
  const nextQuestion = rawNextQuestion
    ? { ...rawNextQuestion, feeds: rawNextQuestion.feeds ?? [] }
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
    openConfirmItems: openConfirmItems(documents),
    openConfirmTotal: openConfirmTotal(documents),
    styleSample: row.styleSampleName ? { name: row.styleSampleName } : null,
    answersCount: row.answersCount,
    deletesAt: deletesAt(row.lastActivityAt),
    createdAt: row.createdAt.toISOString(),
    reclaimable: isReclaimable(row),
    turn: deriveTurnState(row, Date.now()),
    featureDisabled: !governanceEnabled(process.env),
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
