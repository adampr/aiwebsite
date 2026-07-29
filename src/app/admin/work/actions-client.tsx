"use client";

// Approve / retry / delete buttons for /admin/work (§5.16). The API routes
// enforce admin; this island only reflects outcomes.

import { useState } from "react";
import { useRouter } from "next/navigation";

export function WorkAdminActions({
  id,
  status,
  slug,
}: {
  id: string;
  status: string;
  slug: string | null;
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

  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
      {status === "held" && (
        <button
          type="button"
          disabled={busy}
          className="rounded border px-2 py-1"
          onClick={() =>
            void act(
              `/api/work/submissions/${id}/approve`,
              "POST",
              "Publish this held card as-is?"
            )
          }
        >
          Approve as-is
        </button>
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
      <button
        type="button"
        disabled={busy}
        className="rounded border px-2 py-1"
        onClick={() =>
          void act(
            `/api/work/submissions/${id}`,
            "DELETE",
            status === "published"
              ? "Delete this PUBLISHED card? It leaves /work within 5 minutes."
              : "Delete this submission entirely?"
          )
        }
      >
        {status === "published" ? "Unpublish (delete)" : "Delete"}
      </button>
      {status === "published" && slug && (
        <a href={`/work#${slug}`} className="underline">
          View card
        </a>
      )}
      {msg && <span className="text-red-400">{msg}</span>}
    </div>
  );
}
