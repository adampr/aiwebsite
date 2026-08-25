"use client";

// Archive-store list + delete controls for /admin/work#storage (§5.16
// admin cleanup, 2026-08-19). The API route enforces admin; this island
// only reflects outcomes (actions-client pattern). Both delete shapes are
// destructive and get a confirm() (the island's destructive-act marker),
// and the confirm text is HONEST about what remains (refutation M1): a
// row flagged lastCopy has no database copy left anywhere - the bytea was
// cleared after the store copy verified, or the submission is gone - so
// its confirm says unrecoverable, never anything reassuring.
// "Delete selected" runs the per-id DELETEs sequentially and stops on the
// first failure, so a rate-limit refusal surfaces its named wait instead
// of spraying more requests; whatever already deleted stays deleted and
// the refresh shows the survivors still checked-off-able.

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface StorageFileView {
  id: string;
  title: string;
  fileName: string;
  /** Preformatted on the server (formatByteSize). */
  sizeLabel: string;
  /** Preformatted ISO date slice, UTC, with the "UTC" label already baked
   * in server-side (2026-08-25) - do not add a second one here.
   * Deliberately NOT the submissions list's viewer-zone <LocalTime> style:
   * this is the file's STORE date, which work:backfill/work:import can
   * stamp long after the submission, so it is a different fact. */
  dateLabel: string;
  submissionId: string | null;
  /** No database copy remains (submission gone or bytea cleared): this
   * store file is the last copy anywhere. */
  lastCopy: boolean;
}

export function WorkStorageList({ files }: { files: StorageFileView[] }) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  /** One DELETE; returns null on success or the surfaced error message. */
  async function deleteOne(id: string): Promise<string | null> {
    try {
      const res = await fetch(`/api/work/admin/storage/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        return data?.error?.message ?? `Failed (${res.status}).`;
      }
      return null;
    } catch {
      return "Network error; the file may or may not be deleted. Reload.";
    }
  }

  async function deleteFiles(ids: string[], confirmText: string) {
    if (!confirm(confirmText)) return;
    setBusy(true);
    setMsg(null);
    let deleted = 0;
    try {
      for (const id of ids) {
        const err = await deleteOne(id);
        if (err) {
          setMsg(
            ids.length > 1 ? `Deleted ${deleted} of ${ids.length}. ${err}` : err
          );
          break;
        }
        deleted++;
      }
      if (deleted > 0) {
        setSelected(new Set());
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (files.length === 0)
    return <p className="text-sm text-faint">No stored files.</p>;
  // Selection in list (newest-first) order so a partial bulk stop is
  // predictable.
  const selectedIds = files.map((f) => f.id).filter((id) => selected.has(id));
  const selectedLastCopies = files.filter(
    (f) => selected.has(f.id) && f.lastCopy
  ).length;
  return (
    <div className="space-y-2">
      {selectedIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <button
            type="button"
            disabled={busy}
            className="rounded border px-2 py-1"
            onClick={() =>
              void deleteFiles(
                selectedIds,
                selectedLastCopies > 0
                  ? `Delete ${selectedIds.length} selected stored file(s)? ${selectedLastCopies} of them are the LAST copy anywhere (no database copy remains) and cannot be recovered after deletion. The ledger keeps only the records.`
                  : `Delete ${selectedIds.length} selected stored file(s) from the server disk? Their submissions still hold database copies of the uploads; the ledger keeps a record of each deletion.`
              )
            }
          >
            Delete selected ({selectedIds.length})
          </button>
        </div>
      )}
      {files.map((f) => (
        <div
          key={f.id}
          className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--xl-line,#333)] p-3 text-sm"
        >
          <input
            type="checkbox"
            checked={selected.has(f.id)}
            onChange={() => toggle(f.id)}
            aria-label={`Select ${f.fileName} for deletion`}
          />
          <span className="font-medium">{f.title}</span>
          <span className="text-faint">{f.fileName}</span>
          <span className="text-faint">{f.sizeLabel}</span>
          <span className="text-faint">{f.dateLabel}</span>
          {f.submissionId ? (
            <a href={`#sub-${f.submissionId}`} className="underline">
              View submission
            </a>
          ) : (
            // The expected retain-by-design outcome, not an anomaly: a
            // submission delete or the 30-day sweep leaves the file here.
            <span className="text-faint">
              submission removed (file kept by design)
            </span>
          )}
          {f.lastCopy && (
            <span className="rounded-full border px-2 text-xs">last copy</span>
          )}
          <button
            type="button"
            disabled={busy}
            className="rounded border px-2 py-1 text-xs"
            onClick={() =>
              void deleteFiles(
                [f.id],
                f.lastCopy
                  ? `Delete the stored file "${f.fileName}"? This is the LAST copy anywhere: no database copy remains, so it cannot be recovered after deletion. The ledger keeps only the record.`
                  : `Delete the stored file "${f.fileName}" from the server disk? The submission row still holds a database copy of the upload; the ledger keeps a record of the deletion.`
              )
            }
          >
            Delete
          </button>
        </div>
      ))}
      {msg && <p className="text-xs text-red-400">{msg}</p>}
    </div>
  );
}
