// Status projections for the submit page poll (§5.16). Never leaks another
// user's data: routes only call these on rows the caller owns (or as admin).

import { WORK_CAPS } from "./config";
import type { SubmissionRow } from "./db";

export interface SubmissionStatusView {
  id: string;
  title: string;
  kind: string;
  status: string;
  stage: string | null;
  error: string | null;
  slug: string | null;
  stale: boolean;
  createdAt: string;
}

export function statusView(row: SubmissionRow): SubmissionStatusView {
  let stage: string | null = null;
  try {
    const progress = JSON.parse(row.panelProgressJson ?? "null") as {
      stage?: string;
      stageIndex?: number;
      stageCount?: number;
    } | null;
    if (row.status === "running" && progress?.stage)
      stage = `${progress.stage} (${(progress.stageIndex ?? 0) + 1} of ${progress.stageCount ?? 7})`;
  } catch {
    stage = null;
  }
  const stale =
    row.status === "running" &&
    (!row.panelHeartbeatAt ||
      Date.now() - row.panelHeartbeatAt.getTime() > WORK_CAPS.panelStaleMs);
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    status: row.status,
    stage,
    error: row.status === "held" || row.status === "failed" ? row.panelError : null,
    slug: row.status === "published" ? row.slug : null,
    stale,
    createdAt: row.createdAt.toISOString(),
  };
}
