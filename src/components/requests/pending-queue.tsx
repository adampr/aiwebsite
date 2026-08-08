"use client";

// Lane-admin approval queue (§5.19): requests awaiting approval, oldest
// first. Approve lists the request on the board; Reject asks for an
// optional reason (quoted verbatim to the requester). Render-only
// eligibility; the routes re-derive the admin gate.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { REQUEST_CAPS } from "@/lib/work/requests-config";
import { postRequestAction } from "./actions";
import type { QueueRowData } from "./types";

export function PendingQueue({ rows }: { rows: QueueRowData[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function act(id: string, action: "approve" | "reject") {
    if (busyId) return;
    setBusyId(id);
    const message = await postRequestAction(
      `/api/work/requests/${id}/${action}`,
      action === "reject" ? { reason } : undefined
    );
    setError(message);
    setBusyId(null);
    setRejectingId(null);
    setReason("");
    router.refresh();
  }

  if (rows.length === 0) {
    return (
      <p className="text-sm text-faint">Nothing is waiting for approval.</p>
    );
  }

  return (
    <div className="space-y-4">
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      {rows.map((r) => (
        <div
          key={r.id}
          className="border-t border-[var(--xl-line)] pt-3 text-sm"
        >
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-medium">{r.title}</span>
            <span className="mono text-xs text-faint">
              {r.valueLabel}/yr est. · {r.requesterLabel} · {r.submittedOn}
            </span>
          </div>
          <p className="mt-2 whitespace-pre-wrap text-sm">{r.description}</p>
          <ul className="mt-2 list-disc pl-5 text-xs text-faint">
            {r.metrics.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap items-center gap-4">
            <button
              type="button"
              className="btn btn--text"
              aria-disabled={busyId === r.id}
              onClick={() => void act(r.id, "approve")}
            >
              Approve
            </button>
            {rejectingId === r.id ? (
              <span className="flex flex-wrap items-center gap-2">
                <input
                  className="input"
                  aria-label="Reason (optional, sent to the requester)"
                  placeholder="Reason (optional)"
                  value={reason}
                  maxLength={REQUEST_CAPS.rejectReasonMaxChars}
                  onChange={(e) => setReason(e.target.value)}
                />
                <button
                  type="button"
                  className="btn btn--text"
                  aria-disabled={busyId === r.id}
                  onClick={() => void act(r.id, "reject")}
                >
                  Confirm reject
                </button>
                <button
                  type="button"
                  className="btn btn--text"
                  onClick={() => {
                    setRejectingId(null);
                    setReason("");
                  }}
                >
                  Keep it
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="btn btn--text"
                aria-disabled={busyId === r.id}
                onClick={() => setRejectingId(r.id)}
              >
                Reject...
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
