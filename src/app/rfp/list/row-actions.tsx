"use client";

// Per-row actions on /rfp/list (§5.17). Two-step confirms, no dialogs:
// destructive intent is typed out in place, matching the knowledge review
// queue's pattern. Archive is the OWNER's lever (an admin can restore);
// delete is admin-only and permanent.

import { useState } from "react";
import { useRouter } from "next/navigation";

export function RowActions({
  id,
  archived,
  canDelete,
}: {
  id: string;
  archived: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState<"archive" | "delete" | null>(
    null
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function act(path: string, body?: unknown) {
    setBusy(true);
    setError("");
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch(() => null);
    setBusy(false);
    if (!res || !res.ok) {
      const d = res ? await res.json().catch(() => null) : null;
      setError(d?.message ?? "That did not go through.");
      return;
    }
    setConfirming(null);
    router.refresh();
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-3">
      {confirming === null && (
        <>
          <button
            type="button"
            className="linklike text-xs"
            disabled={busy}
            onClick={() =>
              archived
                ? void act(`/api/rfp/documents/${id}/archive`, {
                    archived: false,
                  })
                : setConfirming("archive")
            }
          >
            {archived ? "Restore" : "Archive"}
          </button>
          {canDelete && (
            <button
              type="button"
              className="linklike text-xs"
              disabled={busy}
              onClick={() => setConfirming("delete")}
            >
              Delete
            </button>
          )}
        </>
      )}
      {confirming === "archive" && (
        <span className="text-xs">
          Out of your list; an admin can restore it.{" "}
          <button
            type="button"
            className="linklike"
            disabled={busy}
            onClick={() =>
              void act(`/api/rfp/documents/${id}/archive`, { archived: true })
            }
          >
            Archive it
          </button>{" "}
          <button
            type="button"
            className="linklike text-faint"
            onClick={() => setConfirming(null)}
          >
            Keep
          </button>
        </span>
      )}
      {confirming === "delete" && (
        <span className="text-xs">
          Permanent: the RFP and its draft are gone.{" "}
          <button
            type="button"
            className="linklike"
            disabled={busy}
            onClick={() => void act(`/api/rfp/documents/${id}/delete`)}
          >
            Delete it
          </button>{" "}
          <button
            type="button"
            className="linklike text-faint"
            onClick={() => setConfirming(null)}
          >
            Keep
          </button>
        </span>
      )}
      {error && (
        <span className="badge badge--warn text-xs" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
