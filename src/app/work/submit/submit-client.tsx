"use client";

// /work/submit body (§5.16): the shared <SubmissionForm> plus the "your
// submissions" status list with a 10 s poll while anything is active. The
// list lives ONLY here: this page is the deep-linkable, emailed home of
// submission status. Retry is available to everyone eligible; Withdraw is
// ADMIN-ONLY (owner directive 2026-07-30), and non-admins get one footer
// note naming the removal path instead.

import { useCallback, useEffect, useState } from "react";
import { HELD_NEXT_STEPS } from "@/lib/work/config";
import { SubmissionForm } from "./submission-form";

interface StatusRow {
  id: string;
  title: string;
  kind: string;
  status: string;
  stage: string | null;
  error: string | null;
  heldReason: string | null;
  slug: string | null;
  stale: boolean;
  createdAt: string;
  isUpdate: boolean;
  autoApprove: boolean;
}

/** §5.16 update mode: the published card the form proposes to replace. */
export interface UpdateTarget {
  id: string;
  title: string;
  kind: "skill" | "program";
}

const STATUS_COPY: Record<string, string> = {
  received: "Queued for review",
  running: "Panel reviewing",
  published: "Published",
  held: "Held for review",
  failed: "Review failed",
  pending_approval: "Waiting for approval",
  superseded: "Replaced by an update",
};

export function SubmitClient({
  isAdmin = false,
  adminEmail = "adam@xl.net",
  updateTarget = null,
}: {
  isAdmin?: boolean;
  adminEmail?: string;
  updateTarget?: UpdateTarget | null;
}) {
  const [rows, setRows] = useState<StatusRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/work/submissions", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { submissions: StatusRow[] };
      setRows(data.submissions);
    } catch {
      // poll failures are silent; the next tick retries
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(t);
  }, [refresh]);
  const anyActive = rows.some(
    (r) =>
      r.status === "received" ||
      r.status === "running" ||
      // §5.16 auto-approve: pending_approval is a moments-long transit for
      // an admin web update (the panel swaps it itself). Keep polling so the
      // strip flips to Published instead of freezing on a glimpsed park.
      (r.status === "pending_approval" && r.autoApprove)
  );
  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(t);
  }, [anyActive, refresh]);

  async function retry(id: string) {
    const res = await fetch(`/api/work/submissions/${id}/retry`, {
      method: "POST",
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setError(data?.error?.message ?? "Retry failed.");
    } else {
      setError(null);
    }
    void refresh();
  }

  async function withdraw(id: string) {
    if (!confirm("Withdraw this submission? This deletes it entirely.")) return;
    const res = await fetch(`/api/work/submissions/${id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      // A silent no-op button is worse than an error (rate limit, stale
      // admin render): surface the body like retry() does.
      const data = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setError(data?.error?.message ?? "Withdraw failed.");
    } else {
      setError(null);
    }
    void refresh();
  }

  return (
    <div className="space-y-8">
      <div className="panel panel--raised">
        <SubmissionForm
          context="page"
          onSubmitted={() => void refresh()}
          updateTarget={updateTarget}
        />
      </div>

      {rows.length > 0 && (
        <div className="panel space-y-4">
          <h2 className="mono text-xs uppercase tracking-[0.2em] text-light">
            Your submissions
          </h2>
          {error && <p className="text-sm text-red-400">{error}</p>}
          {rows.map((r) => (
            <div
              key={r.id}
              className="border-t border-[var(--xl-line)] pt-3 text-sm"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-medium">{r.title}</span>
                <span className="badge badge--light">
                  {r.status === "pending_approval" && r.autoApprove
                    ? "Publishing"
                    : (STATUS_COPY[r.status] ?? r.status)}
                </span>
                {r.stage && <span className="text-faint">{r.stage}</span>}
              </div>
              {r.status === "published" && r.slug && (
                <p className="mt-1">
                  Live on{" "}
                  <a href={`/work#${r.slug}`}>the Our Work page</a> (allow up
                  to 5 minutes).
                </p>
              )}
              {r.status === "pending_approval" &&
                (r.autoApprove ? (
                  <p className="mt-1 text-faint">
                    Passed review. Publishing the new version now.
                  </p>
                ) : (
                  <p className="mt-1 text-faint">
                    Passed review. Waiting for Adam to approve the swap; the
                    live card is unchanged until then.
                  </p>
                ))}
              {r.status === "superseded" && (
                <p className="mt-1 text-faint">
                  An approved update replaced this card. The live version is
                  on the Our Work page under the same title.
                </p>
              )}
              {r.status === "held" && (
                <div className="mt-1 space-y-1">
                  {r.heldReason && (
                    <p className="mono whitespace-pre-wrap text-xs text-faint">
                      {r.heldReason}
                    </p>
                  )}
                  {/* A conflict park is a dead end: publish and re-run are
                      impossible, so the generic next-steps line would lie. */}
                  {!r.heldReason?.startsWith(
                    "This update could not be applied"
                  ) && <p className="text-faint">{HELD_NEXT_STEPS}</p>}
                  {isAdmin && (
                    <a
                      href={`/admin/work#sub-${r.id}`}
                      className="btn btn--text no-underline"
                    >
                      Review in the admin queue
                    </a>
                  )}
                </div>
              )}
              {r.error && <p className="mt-1 text-faint">{r.error}</p>}
              <div className="mt-2 flex gap-4">
                {(r.status === "failed" ||
                  r.status === "received" ||
                  r.stale) && (
                  <button
                    type="button"
                    className="btn btn--text"
                    onClick={() => void retry(r.id)}
                  >
                    Retry review
                  </button>
                )}
                {r.status === "published" && (
                  <a
                    href={`/work/submit?update=${r.id}`}
                    className="btn btn--text no-underline"
                  >
                    Submit an update
                  </a>
                )}
                {/* Withdraw is hidden on published rows: DELETE on a
                    swapped-in update is a ROLLBACK, and /admin/work carries
                    the properly-labelled lever (refutation finding). */}
                {isAdmin &&
                  r.status !== "published" &&
                  r.status !== "superseded" && (
                    <button
                      type="button"
                      className="btn btn--text"
                      onClick={() => void withdraw(r.id)}
                    >
                      Withdraw
                    </button>
                  )}
              </div>
            </div>
          ))}
          {!isAdmin && (
            <p className="mt-2 text-xs text-faint">
              Retry review re-runs the panel on the files already uploaded;
              it cannot pick up a replacement file. To ship a new version of
              a card that already published, use Submit an update on its
              row: the update is reviewed like any submission, and the live
              card only changes after Adam approves it. If you submitted the
              wrong file or need a submission removed, email Adam (
              {adminEmail}) with the submission title and he will clear it
              so you can resubmit. A submission already under review keeps
              running until it is removed, so if the wrong file might
              publish, email right away; a published card can still be taken
              down afterward. A submission under a different title does not
              need to wait.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
