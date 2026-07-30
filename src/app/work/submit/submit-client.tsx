"use client";

// /work/submit body (§5.16): the shared <SubmissionForm> plus the "your
// submissions" status list with a 10 s poll while anything is active. The
// list (Retry/Withdraw) lives ONLY here: this page is the deep-linkable,
// emailed home of submission status.

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
}

const STATUS_COPY: Record<string, string> = {
  received: "Queued for review",
  running: "Panel reviewing",
  published: "Published",
  held: "Held for review",
  failed: "Review failed",
};

export function SubmitClient({ isAdmin = false }: { isAdmin?: boolean }) {
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
    (r) => r.status === "received" || r.status === "running"
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
    await fetch(`/api/work/submissions/${id}`, { method: "DELETE" });
    void refresh();
  }

  return (
    <div className="space-y-8">
      <div className="panel panel--raised">
        <SubmissionForm context="page" onSubmitted={() => void refresh()} />
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
                  {STATUS_COPY[r.status] ?? r.status}
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
              {r.status === "held" && (
                <div className="mt-1 space-y-1">
                  {r.heldReason && (
                    <p className="mono whitespace-pre-wrap text-xs text-faint">
                      {r.heldReason}
                    </p>
                  )}
                  <p className="text-faint">{HELD_NEXT_STEPS}</p>
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
                <button
                  type="button"
                  className="btn btn--text"
                  onClick={() => void withdraw(r.id)}
                >
                  Withdraw
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
