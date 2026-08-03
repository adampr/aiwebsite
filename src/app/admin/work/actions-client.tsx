"use client";

// Approve / reject / retry / delete buttons for /admin/work (§5.16). The API
// routes enforce admin; this island only reflects outcomes. Update rows
// (isUpdate) get swap-aware labels and confirms: Approve replaces a live
// card, Delete on a swapped-in child performs a ROLLBACK.

import { useState } from "react";
import { useRouter } from "next/navigation";

export function WorkAdminActions({
  id,
  status,
  slug,
  isUpdate = false,
  targetLive = false,
  parentSuperseded = false,
}: {
  id: string;
  status: string;
  slug: string | null;
  isUpdate?: boolean;
  targetLive?: boolean;
  parentSuperseded?: boolean;
}) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function act(path: string, method: string, confirmText?: string) {
    if (confirmText && !confirm(confirmText)) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(path, { method });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setMsg(data?.error?.message ?? `Failed (${res.status}).`);
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  // A held update whose target is gone can never be approved (the swap
  // re-check parks it again); the dead-end buttons are suppressed so the
  // remaining moves (Reject, Delete) are the only ones offered.
  const canApproveUpdate = isUpdate && targetLive;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
      {status === "pending_approval" && (
        <>
          {canApproveUpdate && (
            <button
              type="button"
              disabled={busy}
              className="rounded border px-2 py-1"
              onClick={() =>
                void act(
                  `/api/work/submissions/${id}/approve`,
                  "POST",
                  "Approve this update? The new version replaces the live card within 5 minutes."
                )
              }
            >
              Approve update
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            className="rounded border px-2 py-1"
            onClick={() =>
              void act(
                `/api/work/submissions/${id}/reject`,
                "POST",
                "Reject this update? The proposal is deleted, the live card stays up, and the submitter gets an email."
              )
            }
          >
            Reject update
          </button>
          <button
            type="button"
            disabled={busy}
            className="rounded border px-2 py-1"
            onClick={() =>
              void act(
                `/api/work/submissions/${id}/rerun`,
                "POST",
                "Run the full panel again on this update?"
              )
            }
          >
            Run the panel again
          </button>
        </>
      )}
      {status === "held" && (
        <>
          {(!isUpdate || canApproveUpdate) && (
            <button
              type="button"
              disabled={busy}
              className="rounded border px-2 py-1"
              onClick={() =>
                void act(
                  `/api/work/submissions/${id}/approve`,
                  "POST",
                  isUpdate
                    ? "Publish this held update draft as-is? The new version replaces the live card within 5 minutes."
                    : "Publish this held card as-is?"
                )
              }
            >
              {isUpdate ? "Approve update as-is" : "Approve as-is"}
            </button>
          )}
          {(!isUpdate || targetLive) && (
            <button
              type="button"
              disabled={busy}
              className="rounded border px-2 py-1"
              onClick={() =>
                void act(
                  `/api/work/submissions/${id}/rerun`,
                  "POST",
                  "Run the full panel again on this submission?"
                )
              }
            >
              Run the panel again
            </button>
          )}
          {isUpdate && (
            <button
              type="button"
              disabled={busy}
              className="rounded border px-2 py-1"
              onClick={() =>
                void act(
                  `/api/work/submissions/${id}/reject`,
                  "POST",
                  "Reject this update? The proposal is deleted, the live card stays up, and the submitter gets an email."
                )
              }
            >
              Reject update
            </button>
          )}
        </>
      )}
      {(status === "failed" || status === "received") && (
        <button
          type="button"
          disabled={busy}
          className="rounded border px-2 py-1"
          onClick={() => void act(`/api/work/submissions/${id}/retry`, "POST")}
        >
          Re-run panel
        </button>
      )}
      {status !== "superseded" && (
        <button
          type="button"
          disabled={busy}
          className="rounded border px-2 py-1"
          onClick={() =>
            void act(
              `/api/work/submissions/${id}`,
              "DELETE",
              parentSuperseded
                ? "Roll back? The previous version of the card is restored and this update is removed."
                : status === "published"
                  ? "Delete this PUBLISHED card? It leaves /work within 5 minutes."
                  : status === "pending_approval" || (isUpdate && status !== "published")
                    ? "Delete this proposed update without emailing the submitter? The live card stays up. Use Reject update if they should be told."
                    : "Delete this submission entirely?"
            )
          }
        >
          {parentSuperseded
            ? "Roll back to previous version"
            : status === "published"
              ? "Unpublish (delete)"
              : "Delete"}
        </button>
      )}
      {status === "published" && slug && (
        <>
          <a href={`/work#${slug}`} className="underline">
            View card
          </a>
          <a href={`/work/submit?update=${id}`} className="underline">
            Submit an update
          </a>
        </>
      )}
      {msg && <span className="text-red-400">{msg}</span>}
    </div>
  );
}
