// Serialized row shapes for the Requested Work islands (§5.19). Server
// pages pre-format every date and dollar value into strings so the islands
// stay purely presentational (no server/client timezone drift on
// hydration) and never receive more than the surface renders.

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
  requestedOn: string;
  completedOn: string | null;
};

export type MineRowData = {
  id: string;
  title: string;
  valueLabel: string;
  status: string;
  statusLabel: string;
  rejectReason: string | null;
  createdOn: string;
};

export type QueueRowData = {
  id: string;
  title: string;
  description: string;
  metrics: string[];
  valueLabel: string;
  requesterLabel: string;
  submittedOn: string;
};
