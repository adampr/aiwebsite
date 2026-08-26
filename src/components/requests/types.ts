// Serialized row shapes for the Requested Work islands (§5.19). Server
// pages pre-format the dollar values and the person labels, and never send
// more than the surface renders.
//
// Timestamps are the deliberate exception: they cross as raw ISO-8601
// instants and the islands render them through <LocalTime withTime>, because
// only the browser knows the reader's zone. The `...At` suffix is the
// contract - an `...At` field is an INSTANT and is never safe to print
// directly (it would paint "2026-08-26T01:30:00.000Z" into user copy). These
// fields used to be `...On` display strings formatted UTC date-only on the
// server, which mislabelled the day for every reader west of Greenwich;
// serialize.ts records why the formatting could not stay server-side.

export type BoardRowData = {
  id: string;
  title: string;
  description: string;
  metrics: string[];
  valueLabel: string; // "$12,500"
  status: string; // WorkRequestStatus
  statusLabel: string;
  requesterLabel: string; // name ?? email
  developerLabel: string | null;
  /** Lowercased; the island compares against viewerEmail for self actions.
   * Board rows are lane-visible, so exposing the developer is by design. */
  developerEmail: string | null;
  /** ISO-8601 instant; render with <LocalTime withTime />. */
  requestedAt: string;
  /** ISO-8601 instant, or null while the request is unfinished. */
  completedAt: string | null;
};

export type MineRowData = {
  id: string;
  title: string;
  valueLabel: string;
  status: string;
  statusLabel: string;
  rejectReason: string | null;
  /** ISO-8601 instant; render with <LocalTime withTime />. */
  createdAt: string;
};

export type QueueRowData = {
  id: string;
  title: string;
  description: string;
  metrics: string[];
  valueLabel: string;
  requesterLabel: string;
  /** ISO-8601 instant; render with <LocalTime withTime />. */
  submittedAt: string;
};
