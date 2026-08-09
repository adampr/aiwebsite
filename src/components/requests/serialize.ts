// Server-side row serialization for the Requested Work islands (§5.19).
// One mapping per island so /work/requested and the two roadmap step pages
// can never drift. Dates and dollars are formatted here (fmtDate is
// UTC-stable) and the islands receive strings only.

import { personLabel } from "@/lib/person-label";
import { fmtDate } from "@/components/roadmap/dates";
import {
  formatValueUsd,
  parseMetricsJson,
  REQUEST_STATUS_COPY,
  type WorkRequestStatus,
} from "@/lib/work/requests-config";
import type { WorkRequestRow } from "@/lib/work/requests-db";
import type { BoardRowData, MineRowData, QueueRowData } from "./types";

function statusLabel(status: string): string {
  return REQUEST_STATUS_COPY[status as WorkRequestStatus] ?? status;
}

export function toBoardRow(r: WorkRequestRow): BoardRowData {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    metrics: parseMetricsJson(r.metricsJson),
    valueLabel: formatValueUsd(r.valueUsd),
    status: r.status,
    statusLabel: statusLabel(r.status),
    requesterLabel: personLabel(r.requesterName, r.requesterEmail),
    // Preserve null when unclaimed (the board's "built by" suffix keys on it).
    developerLabel: r.developerEmail
      ? personLabel(r.developerName, r.developerEmail)
      : null,
    developerEmail: r.developerEmail?.toLowerCase() ?? null,
    requestedOn: fmtDate(r.createdAt),
    completedOn: r.completedAt ? fmtDate(r.completedAt) : null,
  };
}

export function toMineRow(r: WorkRequestRow): MineRowData {
  return {
    id: r.id,
    title: r.title,
    valueLabel: formatValueUsd(r.valueUsd),
    status: r.status,
    statusLabel: statusLabel(r.status),
    rejectReason: r.rejectReason,
    createdOn: fmtDate(r.createdAt),
  };
}

export function toQueueRow(r: WorkRequestRow): QueueRowData {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    metrics: parseMetricsJson(r.metricsJson),
    valueLabel: formatValueUsd(r.valueUsd),
    requesterLabel: personLabel(r.requesterName, r.requesterEmail),
    submittedOn: fmtDate(r.createdAt),
  };
}
