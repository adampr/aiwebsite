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
  currentId: string | null;
}

/** §5.16 update mode: the published card the form proposes to replace. */
export interface UpdateTarget {
  id: string;
  title: string;
  kind: "skill" | "program";
}

// "Your submissions" pager (owner request 2026-08-07): the list is unbounded
// and every retry, update and superseded generation adds a row, so a long
// tenure buried the form under its own history. The window is a plain
// `.slice()` of the already-deduped `visible` array - this list is React-
// rendered from polled state, NOT server-rendered DOM, so nothing here may
// borrow the /work console's `<WorkPager/>` (that island MUTATES
// server-owned nodes and its `.work-pager` CSS is gated on a /work-only
// `html.pager-active` class, i.e. it would render invisible here).
// 0 = All, and it is deliberately last so the default sits first.
const PAGE_SIZES = [10, 50, 0] as const;
const DEFAULT_PAGE_SIZE = 10;

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
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [page, setPage] = useState(0);

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

  // ONE entry per card (owner feedback 2026-08-04, round-11 follow-up #2):
  // when an update of yours replaced your own card, the live row IS the
  // card's entry, and the superseded generation showing beside it under the
  // same title reads as a duplicate. Hidden ONLY when the live version is
  // also in this list; a card whose last update came from someone else
  // keeps its superseded row - that row (and its Submit an update button)
  // is the submitter's only surface. The DB rows all stay: superseded is
  // the rollback reservoir and is undeletable by design.
  const visible = rows.filter(
    (r) =>
      !(
        r.status === "superseded" &&
        r.currentId &&
        rows.some((o) => o.id === r.currentId)
      )
  );

  // The page index is CLAMPED in render, never with setState during render:
  // the 10 s poll and Withdraw both shrink `visible` underneath the pager,
  // and a stale index would paint an empty list while rows plainly exist.
  // Every control below reads `safePage`, never the raw state, so the window
  // and both Prev/Next targets are already right on the render that shrank
  // the list.
  const pageCount =
    pageSize === 0 ? 1 : Math.max(1, Math.ceil(visible.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const windowed =
    pageSize === 0
      ? visible
      : visible.slice(safePage * pageSize, (safePage + 1) * pageSize);
  // Pointless chrome stays out of the way, but ONLY while the size is still
  // the default: someone who picked All must always find the control that
  // puts them back on 10.
  const showPager =
    visible.length > DEFAULT_PAGE_SIZE || pageSize !== DEFAULT_PAGE_SIZE;

  // ...and the clamp is SETTLED back into state, because deriving it alone
  // leaves a stale high index that silently re-applies the moment the list
  // grows again: dedupe drops a superseded row (page 3 of 3 falls back to
  // page 2), then the submitter posts a new package and `refresh()` restores
  // the count, and the view would snap to page 3 with no click - hiding the
  // row they just created, which sorts first. One pass, not a loop: after
  // the write `page === pageCount - 1` and the condition is false.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- settle a clamp the render already applied; guarded, so exactly one extra render and it cannot re-enter
    if (page > pageCount - 1) setPage(pageCount - 1);
  }, [page, pageCount]);

  function changeSize(next: number) {
    // Re-anchor on the first row of the current window so a size change
    // keeps the reader roughly where they were instead of teleporting.
    const anchor = pageSize === 0 ? 0 : safePage * pageSize;
    setPageSize(next);
    setPage(next === 0 ? 0 : Math.floor(anchor / next));
  }

  function goTo(next: number) {
    if (next < 0 || next >= pageCount) return;
    setPage(next);
  }

  const pad = (n: number) => String(n).padStart(2, "0");
  const countLabel = `${visible.length} submission${
    visible.length === 1 ? "" : "s"
  }`;
  const readout =
    pageSize === 0
      ? countLabel
      : `Page ${pad(safePage + 1)} / ${pad(pageCount)} · ${countLabel}`;

  // Rendered above AND below the rows: a full page of status cards runs well
  // past one screen, and a pager you have to scroll back up to reach is the
  // reason page 2 goes unvisited. The bottom strip is a duplicate control,
  // so only the top readout is announced.
  const pagerStrip = (bottom: boolean) => {
    const sizeId = bottom ? "sub-page-size-bottom" : "sub-page-size";
    return (
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-[var(--xl-line)] pt-3">
        <div className="flex items-center gap-3">
          <label
            htmlFor={sizeId}
            className="mono text-xs uppercase tracking-[0.2em] text-light"
          >
            Show
          </label>
          <select
            id={sizeId}
            className="input"
            // A SUPERSET of the visible "Show": an aria-label that dropped
            // that word would leave a voice-control user saying "click Show"
            // with nothing to match (WCAG 2.5.3 Label in Name).
            aria-label="Show submissions per page"
            value={pageSize}
            onChange={(e) => changeSize(Number(e.target.value))}
          >
            {PAGE_SIZES.map((s) => (
              <option key={s} value={s}>
                {s === 0 ? "All" : s}
              </option>
            ))}
          </select>
        </div>
        {/* Both arrows stay MOUNTED and use aria-disabled, never the
            `disabled` attribute or a `pageCount > 1` conditional: either one
            would yank the element out from under the focus of the keyboard
            user who just pressed it (a disabled or unmounted node blurs to
            <body>, so their next Tab restarts at the top of the document,
            back through the whole submission form). goTo() range-guards, so
            an inert arrow is already a no-op. Same call the /work console's
            pager makes. */}
        <div className="flex items-center gap-4">
          <button
            type="button"
            className="btn btn--text"
            aria-disabled={safePage === 0}
            onClick={() => goTo(safePage - 1)}
          >
            Prev
          </button>
          <span
            className="mono text-xs uppercase tracking-[0.2em] text-faint"
            aria-live={bottom ? undefined : "polite"}
            aria-hidden={bottom ? true : undefined}
          >
            {readout}
          </span>
          <button
            type="button"
            className="btn btn--text"
            aria-disabled={safePage >= pageCount - 1}
            onClick={() => goTo(safePage + 1)}
          >
            Next
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-8">
      <div className="panel panel--raised">
        <SubmissionForm
          context="page"
          onSubmitted={() => void refresh()}
          updateTarget={updateTarget}
        />
      </div>

      {visible.length > 0 && (
        <div className="panel space-y-4">
          <h2 className="mono text-xs uppercase tracking-[0.2em] text-light">
            Your submissions
          </h2>
          {error && <p className="text-sm text-red-400">{error}</p>}
          {showPager && pagerStrip(false)}
          {windowed.map((r) => (
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
                  <a href={`/work#${r.slug}`}>the Our Work page</a>.
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
                {/* Chain ownership (§5.16, 2026-08-04): a superseded row
                    links to updating the card's LIVE version. Shown even
                    when the live row is also in this list (owner feedback,
                    same day): the original row is where people look for
                    their card, and a dedupe that hides the button there
                    recreates the "no option to update again" confusion.
                    Both buttons land on the same update form. */}
                {r.status === "superseded" && r.currentId && (
                  <a
                    href={`/work/submit?update=${r.currentId}`}
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
          {showPager && pagerStrip(true)}
          {!isAdmin && (
            <p className="mt-2 text-xs text-faint">
              A queued review starts on its own as soon as the panel and
              daily capacity are free; Retry review is the manual lever,
              re-running the panel on the files already uploaded, and it
              cannot pick up a replacement file. To ship a new version of
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
