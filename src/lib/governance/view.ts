// Row -> API view mapping (§5.12). JSON columns are parsed defensively (a
// corrupt column degrades to an empty value, never a 500) and the view is the
// single place the client learns about retention dates, progress, and whether
// a queued/stale row is reclaimable (the client then POSTs /research — GETs
// never claim anything).

import type {
  GovernanceDoc,
  GovernanceKind,
  NextQuestion,
  ProjectStatus,
  ProjectSummary,
  ProjectView,
  ResearchProgress,
  TranscriptEntry,
} from "./types";
import { placeholderSectionMap } from "./blueprints";
import { governanceEnabled } from "./config";
import { findConfirmMarkers } from "./markdown";
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

export function openConfirmItems(
  documents: GovernanceDoc[]
): { doc: string; section: string; excerpt: string }[] {
  const out: { doc: string; section: string; excerpt: string }[] = [];
  for (const d of documents)
    for (const s of d.sections)
      for (const excerpt of findConfirmMarkers(s.markdown))
        out.push({ doc: d.slug, section: s.id, excerpt });
  return out.slice(0, 50);
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
    styleSample: row.styleSampleName ? { name: row.styleSampleName } : null,
    answersCount: row.answersCount,
    deletesAt: deletesAt(row.lastActivityAt),
    createdAt: row.createdAt.toISOString(),
    reclaimable: isReclaimable(row),
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
