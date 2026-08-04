"use client";

// Request Admin Access island (§5.18). The hub computes the standing state
// server-side (openAdminRequest / deniedAdminRequestInWindow) and passes it
// as props; this island only carries the click. A denied request renders
// exactly like a pending one (denial is observably identical to
// non-approval by ruling), and the API maps a re-click to the same
// "pending" outcome.

import { useState } from "react";
import { fmtDate } from "@/components/roadmap/dates";

type Pending = { requestedAt: string; expiresAt: string };

export function RequestAdminAccess({
  pending: initialPending,
}: {
  pending: Pending | null;
}) {
  const [pending, setPending] = useState<Pending | null>(initialPending);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (pending) {
    return (
      <p className="mono text-xs text-faint">
        Admin access requested {fmtDate(pending.requestedAt)}; approvers were
        emailed; expires {fmtDate(pending.expiresAt)}.
      </p>
    );
  }

  async function request() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/roadmap/company/admin-request", {
        method: "POST",
      });
      const data = (await res.json().catch(() => null)) as {
        outcome?: string;
        requestedAt?: string;
        expiresAt?: string;
        error?: { message?: string };
      } | null;
      if (res.ok && data?.requestedAt && data?.expiresAt) {
        setPending({
          requestedAt: data.requestedAt,
          expiresAt: data.expiresAt,
        });
        return;
      }
      setError(
        data?.error?.message ?? "Something went wrong. Try again shortly."
      );
    } catch {
      setError("Something went wrong. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        className="btn"
        disabled={busy}
        aria-busy={busy}
        onClick={request}
      >
        {busy ? "Requesting..." : "Request admin access"}
      </button>
      <p className="text-xs text-faint">
        Your company&apos;s current admins and XL.net are emailed; any one of
        them can approve.
      </p>
      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
