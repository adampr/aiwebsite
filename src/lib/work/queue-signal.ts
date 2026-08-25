// §5.16 queue-wait stamp (2026-08-25 round): the reason the queue has not
// started a received row yet, so a submitter watching the tracker is told
// "a site update is finishing" instead of nothing at all.
//
// Why the row's WAIT REASON is process memory and not a column: the reason is
// knowledge that expires in about a minute, the drain already keeps its state
// on globalThis, and no migration can be justified for it. Wiped by a restart,
// which is precisely the deploy case, so the readers fall back to
// deployBlocksPanel().
//
// Imports only ./config (no DB, no panel), so routes can import it with no
// cycle.

import { QUEUE_SIGNAL_TTL_MS } from "./config";

interface QueueWait {
  rowId: string;
  reason: string;
  atMs: number;
}

const G = globalThis as typeof globalThis & { __workQueueWait?: QueueWait | null };

/** reason null clears the stamp (a run was admitted), so a stale reason cannot
 * outlive its cause. */
export function noteQueueWait(rowId: string, reason: string | null): void {
  G.__workQueueWait = reason ? { rowId, reason, atMs: Date.now() } : null;
}

/** KEYED ON THE ROW, deliberately: a single process-global reason rendered
 * under every received row would narrate user A's refusal under user B's
 * submission, and would stamp one story across every row of the admin
 * ?scope=all list. */
export function readQueueWait(rowId: string): string | null {
  const s = G.__workQueueWait;
  if (!s || s.rowId !== rowId) return null;
  if (Date.now() - s.atMs > QUEUE_SIGNAL_TTL_MS) return null;
  return s.reason;
}

/** The resolver both GETs use, so the deploy fallback lives in one place. */
export function queueReasonFor(
  rowId: string,
  deployBlocks: boolean
): string | null {
  return readQueueWait(rowId) ?? (deployBlocks ? "deploy" : null);
}
