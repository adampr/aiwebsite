"use client";

// "Your requests" (§5.19): the requester's own rows in every status - the
// ONE surface where their pending and rejected requests appear. Cancel is
// offered on pending rows only (approved rows are delisted by an admin).

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PagerStrip, usePagedList } from "@/components/list-pager";
import { REQUEST_CAPS } from "@/lib/work/requests-config";
import { postRequestAction } from "./actions";
import type { MineRowData } from "./types";

export function MyRequests({
  rows,
  capped,
}: {
  rows: MineRowData[];
  capped: boolean;
}) {
  const router = useRouter();
  const pager = usePagedList(rows, "request");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function cancel(id: string) {
    if (busyId) return;
    if (!confirm("Cancel this request? This removes it entirely.")) return;
    setBusyId(id);
    const message = await postRequestAction(`/api/work/requests/${id}/cancel`);
    setError(message);
    setBusyId(null);
    router.refresh();
  }

  if (rows.length === 0) {
    return (
      <p className="text-sm text-faint">
        You have not requested anything yet.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      {pager.showPager && (
        <PagerStrip pager={pager} idPrefix="mine" />
      )}
      {pager.windowed.map((r) => (
        <div
          key={r.id}
          className="border-t border-[var(--xl-line)] pt-3 text-sm"
        >
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-medium">{r.title}</span>
            <span className="badge badge--light">{r.statusLabel}</span>
            <span className="mono text-xs text-faint">
              {r.valueLabel}/yr est. · filed {r.createdOn}
            </span>
          </div>
          {r.status === "rejected" && r.rejectReason && (
            <p className="mt-1 text-xs text-faint">Reason: {r.rejectReason}</p>
          )}
          {r.status === "pending" && (
            <div className="mt-2">
              <button
                type="button"
                className="btn btn--text"
                aria-disabled={busyId === r.id}
                onClick={() => void cancel(r.id)}
              >
                Cancel request
              </button>
            </div>
          )}
        </div>
      ))}
      {pager.showPager && (
        <PagerStrip pager={pager} idPrefix="mine" bottom />
      )}
      {capped && (
        <p className="mono text-xs text-faint">
          Showing the most recent {REQUEST_CAPS.listMax}.
        </p>
      )}
    </div>
  );
}
