"use client";

// The one mutating control on the approval page (§5.18). The POST re-derives
// the approver predicate server-side; this island only carries the click.

import { useState } from "react";

export function ApproveButton({ requestId }: { requestId: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">(
    "idle"
  );
  const [message, setMessage] = useState("");

  async function approve() {
    setState("busy");
    try {
      const res = await fetch("/api/roadmap/company/admin-request/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ req: requestId }),
      });
      const body = (await res.json().catch(() => null)) as {
        approved?: boolean;
        error?: { message?: string };
      } | null;
      if (res.ok && body?.approved) {
        setState("done");
        return;
      }
      setMessage(
        body?.error?.message ??
          "That did not work. Someone else may have decided this request already."
      );
      setState("error");
    } catch {
      setMessage("Network problem. Try again.");
      setState("error");
    }
  }

  if (state === "done")
    return (
      <p className="text-sm" role="status">
        Approved. The requester has been emailed and is now a company admin.
      </p>
    );
  return (
    <div className="space-y-2">
      <button
        type="button"
        className="btn"
        onClick={approve}
        disabled={state === "busy"}
        aria-busy={state === "busy"}
      >
        {state === "busy" ? "Approving..." : "Approve admin access"}
      </button>
      {state === "error" && (
        <p className="text-sm" role="alert" style={{ color: "#e5484d" }}>
          {message}
        </p>
      )}
    </div>
  );
}
