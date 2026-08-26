// Server-side row serialization for the Requested Work islands (§5.19).
// One mapping per island so /work/requested and the two roadmap step pages
// can never drift. Dollars and labels are formatted here; TIMESTAMPS ARE
// NOT, and that is the whole point of the `...At` suffixes below.
//
// Owner directive 2026-08-26: every stored timestamp a reader sees renders
// in the VIEWER's zone, with a clock. This file used to call fmtDate(),
// which pinned timeZone:"UTC" and dropped the time entirely, so a request
// filed at 20:00 in Chicago was labelled with the NEXT day's date on the
// board of the person who filed it - and with no clock on the row there was
// nothing to reveal the off-by-one.
//
// The formatting could not simply move into the islands as a bare
// toLocaleString either. All three islands are "use client", but three
// async server pages import them STATICALLY (there is no next/dynamic and
// no ssr:false anywhere under src/), so the App Router server-renders them:
// a runtime-zone format yields UTC on the VM and the reader's zone in the
// browser, the two strings differ whenever the civil dates straddle
// midnight, and with no Suspense boundary between an island and the router
// root React discards the server HTML and re-renders the whole page
// (a6b52ef, admin/roadmap/actions-client.tsx). exact() has exactly that
// defect and is NOT an option here. <LocalTime> is, because its useState
// seed is UTC-pinned unconditionally: both sides emit identical bytes and
// the swap to the browser's zone happens in a deferred effect, after
// hydration has already matched. So the instant crosses raw and the island
// renders it.

import { personLabel } from "@/lib/person-label";
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
    // Raw instants, not display strings: see the file header. createdAt is
    // .notNull() timestamptz so drizzle always hands back a Date and
    // .toISOString() cannot throw; completedAt is nullable and stays null
    // rather than becoming "", because the board's "· completed X" suffix
    // keys on it and an empty string would print a bare middot.
    requestedAt: r.createdAt.toISOString(),
    completedAt: r.completedAt?.toISOString() ?? null,
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
    createdAt: r.createdAt.toISOString(),
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
    submittedAt: r.createdAt.toISOString(),
  };
}
