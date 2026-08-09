"use client";

// Admin-only island for roadmap step 4 (§5.18): add a published submitter
// who is missing from the directory. Posts to the directory API with the
// email prefilled and the local part as the starting name (merge flows are
// a deferral); the server re-renders the joined scorecard on refresh.

import { useState } from "react";
import { useRouter } from "next/navigation";

export function AddToDirectory({ email }: { email: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/roadmap/directory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          // parsePersonFields requires >= 2 chars: a one-char local part
          // (a@xl.net) falls back to the full address as the name.
          name:
            email.split("@")[0].length >= 2 ? email.split("@")[0] : email,
          email,
          phone: null,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(
          data?.error?.message ?? "Something went wrong. Try again shortly."
        );
        return;
      }
      router.refresh();
    } catch {
      setError("Something went wrong. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-3">
      <button
        type="button"
        className="btn btn--text"
        disabled={busy}
        aria-busy={busy}
        onClick={add}
      >
        {busy ? "Adding..." : "Add to directory"}
      </button>
      {error && (
        <span role="alert" className="text-xs text-red-400">
          {error}
        </span>
      )}
    </span>
  );
}
