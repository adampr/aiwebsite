"use client";

// The lane board (§5.19): every listed request (approved, in progress,
// awaiting validation, completed - never pending/rejected), paginated
// 10/50/All, with the actions the viewer is entitled to. Eligibility here
// is RENDER-only; every route re-derives its own gate. After any action the
// island reports the server's own verdict and router.refresh()es so the
// server-rendered counts around it stay honest.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PagerStrip, usePagedList } from "@/components/list-pager";
import { REQUEST_CAPS } from "@/lib/work/requests-config";
import { postRequestAction } from "./actions";
import type { BoardRowData } from "./types";

export function RequestBoard({
  rows,
  viewerEmail,
  isAdmin,
  activeClaims,
  capped,
}: {
  rows: BoardRowData[];
  viewerEmail: string;
  isAdmin: boolean;
  /** The viewer's current 3-cap holdings (render hint only). */
  activeClaims: number;
  /** True when rows hit the server-side listMax. */
  capped: boolean;
}) {
  const router = useRouter();
  const pager = usePagedList(rows, "request");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(id: string, action: string) {
    if (busyId) return;
    setBusyId(id);
    const message = await postRequestAction(`/api/work/requests/${id}/${action}`);
    setError(message);
    setBusyId(null);
    router.refresh();
  }

  const atClaimCap = activeClaims >= REQUEST_CAPS.concurrentPerDeveloper;

  if (rows.length === 0) {
    return (
      <p className="text-sm text-faint">
        Nothing on the board yet. Approved requests appear here for anyone to
        claim.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      {pager.showPager && (
        <PagerStrip pager={pager} idPrefix="board" />
      )}
      {pager.windowed.map((r) => {
        const mine =
          r.developerEmail !== null &&
          r.developerEmail === viewerEmail.toLowerCase();
        const busy = busyId === r.id;
        return (
          <div
            key={r.id}
            className="border-t border-[var(--xl-line)] pt-3 text-sm"
          >
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-medium">{r.title}</span>
              <span className="badge badge--light">{r.statusLabel}</span>
              <span className="mono text-xs text-faint">
                {r.valueLabel}/yr est.
              </span>
            </div>
            <p className="mt-1 text-xs text-faint">
              Requested by {r.requesterLabel} on {r.requestedOn}
              {r.developerLabel ? ` · built by ${r.developerLabel}` : ""}
              {r.completedOn ? ` · completed ${r.completedOn}` : ""}
            </p>
            <details className="mt-1">
              <summary className="cursor-pointer text-xs text-faint">
                Details and value metrics
              </summary>
              <p className="mt-2 whitespace-pre-wrap text-sm">{r.description}</p>
              <ul className="mt-2 list-disc pl-5 text-xs text-faint">
                {r.metrics.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            </details>
            <div className="mt-2 flex flex-wrap gap-4">
              {r.status === "approved" && !atClaimCap && (
                <button
                  type="button"
                  className="btn btn--text"
                  aria-disabled={busy}
                  onClick={() => void act(r.id, "claim")}
                >
                  {busy ? "Working..." : "Claim this project"}
                </button>
              )}
              {r.status === "approved" && atClaimCap && (
                <span className="text-xs text-faint">
                  You are at {REQUEST_CAPS.concurrentPerDeveloper} projects;
                  finish one to claim this.
                </span>
              )}
              {r.status === "in_progress" && mine && (
                <>
                  <button
                    type="button"
                    className="btn btn--text"
                    aria-disabled={busy}
                    onClick={() => void act(r.id, "complete")}
                  >
                    Mark complete
                  </button>
                  <button
                    type="button"
                    className="btn btn--text"
                    aria-disabled={busy}
                    onClick={() => void act(r.id, "unclaim")}
                  >
                    Unclaim
                  </button>
                </>
              )}
              {r.status === "in_progress" && !mine && isAdmin && (
                <button
                  type="button"
                  className="btn btn--text"
                  aria-disabled={busy}
                  onClick={() => void act(r.id, "unclaim")}
                >
                  Unclaim (admin)
                </button>
              )}
              {r.status === "done_pending" && isAdmin && (
                <>
                  <button
                    type="button"
                    className="btn btn--text"
                    aria-disabled={busy}
                    onClick={() => void act(r.id, "validate")}
                  >
                    Validate completion
                  </button>
                  <button
                    type="button"
                    className="btn btn--text"
                    aria-disabled={busy}
                    onClick={() => void act(r.id, "send-back")}
                  >
                    Send back
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })}
      {pager.showPager && (
        <PagerStrip pager={pager} idPrefix="board" bottom />
      )}
      {capped && (
        <p className="mono text-xs text-faint">
          Showing the most recent {REQUEST_CAPS.listMax}.
        </p>
      )}
    </div>
  );
}
