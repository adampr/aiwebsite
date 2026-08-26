"use client";

// Request Admin Access island (§5.18). The hub computes the standing state
// server-side (openAdminRequest / deniedAdminRequestInWindow) and passes it
// as props; this island only carries the click. A denied request renders
// exactly like a pending one (denial is observably identical to
// non-approval by ruling), and the API maps a re-click to the same
// "pending" outcome.

import { useState } from "react";
import { LocalTime } from "@/components/local-time";

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
    // Owner directive 2026-08-26: both halves in the VIEWER's zone,
    // both with a clock, and both at the SAME precision. This island is
    // "use client" but /roadmap imports it STATICALLY and resolves
    // `pending` server-side, so this branch is server-rendered on the
    // first paint - which is why it takes <LocalTime> and not exact():
    // exact() formats in the runtime zone, and during SSR that zone is
    // the VM's, so the two renders would disagree and React would throw
    // away the server HTML for the hub (a6b52ef). fmtDate() did not
    // mismatch, because it pinned UTC - it was simply wrong for everyone,
    // and silently: expiresAt is requestedAt + 7 days, so both halves
    // carried the identical wrong hour-of-day and the sentence stayed
    // internally consistent while both of its dates were off by one for
    // any viewer west of Greenwich. They move together by rule; a clock
    // on the deadline beside a bare date on the request reads broken.
    // The mirror of this sentence is on /roadmap/approve-admin (the
    // approver's side of the same row) and was converted with it.
    // One-tick note: after a successful POST, setPending() mounts a
    // fresh <LocalTime> whose useState seed is UTC-pinned, so the
    // just-filed request shows " UTC" for a tick before the effect swaps
    // it. That is the price of a component that must also survive
    // hydration, and the SSR path is the common one. Semicolons and the
    // sentence stop stay OUTSIDE the elements: <LocalTime> owns a <time
    // dateTime>, and punctuation is not part of a timestamp.
    return (
      <p className="mono text-xs text-faint">
        Admin access requested{" "}
        <LocalTime iso={pending.requestedAt} withTime />; approvers were
        emailed; expires <LocalTime iso={pending.expiresAt} withTime />.
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
