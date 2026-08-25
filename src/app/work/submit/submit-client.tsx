"use client";

// /work/submit body (§5.16): the shared <SubmissionForm> plus the "your
// submissions" status list with a 10 s poll while anything is active. The
// list lives ONLY here: this page is the deep-linkable, emailed home of
// submission status. Retry is available to everyone eligible; Withdraw is
// ADMIN-ONLY (owner directive 2026-07-30), and non-admins get one footer
// note naming the removal path instead.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  HELD_NEXT_STEPS,
  isTransferableStatus,
  KIND_LABELS,
  WORK_CAPS,
  type WorkKind,
} from "@/lib/work/config";
import { exact } from "@/lib/rfp/time";
import { personLabel } from "@/lib/person-label";
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
  /** §5.16 transfer round: the current owner. Rendered only in the admin
   * all-submissions view, where the list is not all one person's. */
  owner: string;
  /** Set when the row has been moved since it was created. */
  movedFrom: string | null;
  lane: "internal" | "company";
  /** Company lane only: which tenant, and the domain its rows may move to. */
  laneName: string | null;
  laneDomain: string | null;
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
  canListAll = false,
  canTransfer = false,
  viewerEmail = "",
  transferCandidates = [],
}: {
  isAdmin?: boolean;
  adminEmail?: string;
  updateTarget?: UpdateTarget | null;
  /** May this session actually USE ?scope=all. Gated on the route's own
   * verifiedWebAdmin predicate, not on bare isAdmin: a control that always
   * 403s is worse than one that is not there. */
  canListAll?: boolean;
  /** May this session actually MOVE a submission. The transfer route
   * provider-checks the owner path (it is the one verb that permanently
   * strips an owner), so a Microsoft-signed staffer would meet a 403 after
   * typing an address and confirming. The control is hidden for them and a
   * line below the list says how to get it. */
  canTransfer?: boolean;
  /** The signed-in address, so the all-submissions view can mark which rows
   * are the viewer's own and keep them rendering exactly as they do in
   * "Your submissions". */
  viewerEmail?: string;
  /** Type-ahead options for "Move to someone else" (staff lane only). */
  transferCandidates?: { email: string; name: string | null }[];
}) {
  const [rows, setRows] = useState<StatusRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [page, setPage] = useState(0);
  // §5.16 transfer round (owner directive 2026-08-09: a second button next
  // to "Your submissions"). Admin-only; a non-admin never renders the
  // toggle and the route refuses the scope regardless.
  const [view, setView] = useState<"mine" | "all">("mine");
  // A ref, not the state value, is what refresh() reads: keeping the callback
  // dependency-free means the mount effect runs exactly once. Reading `view`
  // inside it would change its identity on every switch and fire a second,
  // duplicate fetch behind the one switchView already started.
  const viewRef = useRef<"mine" | "all">("mine");
  const [loading, setLoading] = useState(true);
  const [truncated, setTruncated] = useState(false);
  // Confirmation of a move, kept at panel level ON PURPOSE: in "Your
  // submissions" a successful move makes the row DISAPPEAR (it is not yours
  // any more), and a vanished row with no message reads as a deletion.
  const [notice, setNotice] = useState<string | null>(null);
  // Which row has its move form open, what is typed in it, and the per-row
  // refusal. Per row, not panel-wide: a message at the top of a 10-row page
  // is invisible to someone acting on the last row.
  const [moveOpen, setMoveOpen] = useState<string | null>(null);
  const [moveEmail, setMoveEmail] = useState("");
  const [moveMsg, setMoveMsg] = useState<{ id: string; text: string } | null>(
    null
  );
  const [moveBusy, setMoveBusy] = useState(false);
  const noticeRef = useRef<HTMLParagraphElement | null>(null);

  const refresh = useCallback(async (scope?: "mine" | "all") => {
    const s = scope ?? viewRef.current;
    try {
      const res = await fetch(
        s === "all"
          ? "/api/work/submissions?scope=all"
          : "/api/work/submissions",
        { cache: "no-store" }
      );
      if (res.ok) {
        const data = (await res.json()) as {
          submissions: StatusRow[];
          truncated?: boolean;
        };
        // Late reply from a scope the reader has since left: dropping it is
        // what stops a slow all-list from repainting over the own-list they
        // switched back to.
        if (s !== viewRef.current) return;
        setRows(data.submissions);
        setTruncated(!!data.truncated);
        setError(null);
      } else {
        // A swallowed refusal is a LIE, not a silence: with no rows and no
        // error the list paints "No submissions yet." over a 403 or a 429,
        // which is the class of falsehood the 2026-08-07 pager round was
        // reported for. This covers the OWN list too: the 10 s poll only
        // runs while a row is active, so "the next tick recovers" is false
        // for exactly the reader who has nothing in flight. A later success
        // clears it (setError(null) above).
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        if (s !== viewRef.current) return;
        setError(
          body?.error?.message ??
            `That list could not be loaded (${res.status}).`
        );
      }
    } catch {
      // poll failures are silent; the next tick retries
    }
    // Outside the try and AFTER the staleness return on purpose: a refused
    // or thrown request must still clear the spinner (a 403 or a 429 would
    // otherwise leave "Loading submissions." on screen for good), while a
    // stale reply must NOT clear it out from under the request still in
    // flight, which would flash the empty state over a list that has rows.
    if (s === viewRef.current) setLoading(false);
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
    // The all-submissions view does NOT poll. Across every submitter there is
    // almost always something active, so anyActive would pin a 200-row read
    // (plus a live-descendant lookup per superseded row) to a permanent 10 s
    // tick for a view nobody watches for progress. Its Refresh control is
    // the lever, and the copy promises nothing automatic.
    if (!anyActive || view === "all") return;
    const t = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(t);
  }, [anyActive, refresh, view]);

  /** Case-folded, because a moved row stores the address its mover typed
   * while the session carries whatever the provider issued. In "Your
   * submissions" every row is yours by construction; this only ever
   * discriminates inside the all view. */
  const isMine = (r: StatusRow) =>
    // In "Your submissions" every row is yours by construction, so the
    // answer is yes WITHOUT consulting viewerEmail. That is deliberate: if
    // this compared addresses in both views, an empty or differently-cased
    // viewerEmail would silently strip Retry review and Submit an update
    // from the owner's own list.
    view === "mine" ||
    (!!viewerEmail && r.owner.toLowerCase() === viewerEmail.toLowerCase());

  function switchView(next: "mine" | "all") {
    if (next === view) return;
    viewRef.current = next;
    setView(next);
    // Cleared, not kept: the rows on screen belong to the OTHER scope, and
    // in the all view they render an owner column that would be wrong for a
    // frame. Page state resets with them.
    setRows([]);
    setLoading(true);
    setPage(0);
    setMoveOpen(null);
    setMoveMsg(null);
    setError(null);
    // Both are answers about the list you are LEAVING: a "X now belongs to Y"
    // line and a truncation claim carried into the other scope are stale the
    // moment the rows under them change.
    setNotice(null);
    setTruncated(false);
    void refresh(next);
  }

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

  async function withdraw(row: StatusRow) {
    const id = row.id;
    if (
      !confirm(
        isMine(row)
          ? `Withdraw "${row.title}"? This deletes it entirely.`
          : `Withdraw "${row.title}"? This deletes ${row.owner}'s submission entirely.`
      )
    )
      return;
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

  // §5.16 transfer: hand the submission to someone else.
  //
  // It DOES get a confirm(), and the confirm names both the submission and
  // the address. The repo's convention is not literally "destructive": it
  // also guards Approve update, which publishes. What the two share is that
  // the actor cannot undo the click alone, and that is true here (only the
  // recipient or Adam can move it back). The mistake being guarded is
  // picking the wrong person, and the last cheap moment to catch it is after
  // the field is filled and before the POST, with the address read back.
  async function move(row: StatusRow) {
    const email = moveEmail.trim();
    if (!email) {
      setMoveMsg({
        id: row.id,
        text: "Enter the email address of the person this should belong to.",
      });
      return;
    }
    if (
      !confirm(
        `Move "${row.title}" to ${email}? It becomes their submission${
          view === "mine" ? " and leaves this list" : ""
        }, and they are emailed. ${
          row.lane === "internal"
            ? "Only the new owner or Adam can move it back."
            : "Only Adam can move it back: a company page has no such control."
        }`
      )
    )
      return;
    setMoveBusy(true);
    setMoveMsg(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/work/submissions/${row.id}/transfer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setMoveMsg({
          id: row.id,
          text: data?.error?.message ?? "That move did not go through.",
        });
        return;
      }
      const data = (await res.json()) as { owner?: string };
      setMoveOpen(null);
      setMoveEmail("");
      // No delivery claim. notifyTransfer skips the recipient mail entirely
      // when the actor IS the recipient (an admin taking a row over), and
      // sendGovernanceEmail returns false with no RESEND_API_KEY or on a
      // provider failure, neither of which this response can see. "Being
      // emailed" describes the attempt the code actually makes.
      const newOwner = data.owner ?? email;
      const mailed = !viewerEmail || newOwner.toLowerCase() !== viewerEmail.toLowerCase();
      setNotice(
        `"${row.title}" now belongs to ${newOwner}${
          view === "mine" ? " and has left your list" : ""
        }.${mailed ? " They are being emailed." : ""}`
      );
      // The control that was pressed unmounts, and in the own list so does
      // the whole row, so focus would fall to <body> and the next Tab would
      // restart at the top of the submission form. Same rule the pager arrows
      // and the view toggle follow. role="status" announces it as well.
      requestAnimationFrame(() => noticeRef.current?.focus());
      await refresh();
    } finally {
      setMoveBusy(false);
    }
  }

  // ONE entry per card (owner feedback 2026-08-04, round-11 follow-up #2):
  // when an update of yours replaced your own card, the live row IS the
  // card's entry, and the superseded generation showing beside it under the
  // same title reads as a duplicate. Hidden ONLY when the live version is
  // also in this list; a card whose last update came from someone else
  // keeps its superseded row - that row (and its Submit an update button)
  // is the submitter's only surface. The DB rows all stay: superseded is
  // the rollback reservoir and is undeletable by design.
  // ...and it applies to "Your submissions" ONLY. The all-submissions view is
  // a ROW inventory whose entire job is "who owns which row, so I can move
  // it": hiding rows there is the same failure as a total that lies, and the
  // all list deliberately carries no currentId to dedupe on (computing it
  // costs a chain walk per superseded row).
  const visible =
    view === "all"
      ? rows
      : rows.filter(
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

      {/* ONE datalist for every row's move field. Options carry the address
          as the value and, when a real "First Last" is known, that name as
          the label, so two people with the same first name stay
          distinguishable. person-label.ts governs here: a picker option is
          none of its three documented exclusions. */}
      {transferCandidates.length > 0 && (
        <datalist id="work-transfer-people">
          {transferCandidates.map((c) => {
            const label = personLabel(c.name, c.email);
            return (
              <option
                key={c.email}
                value={c.email}
                label={label === c.email ? undefined : label}
              />
            );
          })}
        </datalist>
      )}

      {/* The panel used to render only when the viewer had rows of their own,
          which would hide the All submissions control from an admin who has
          none - and that control is the whole point of the round (owner
          directive 2026-08-09: the second button sits NEXT TO "Your
          submissions"). Gated on canListAll, the same predicate the toggle
          itself uses, plus `notice`: a successful move can empty the own list,
          and unmounting the panel would take the confirmation with it, so the
          rows and the explanation would vanish together and read as a
          deletion. */}
      {(visible.length > 0 || canListAll || notice) && (
        <div className="panel space-y-4">
          {canListAll ? (
            <div className="flex flex-wrap items-center gap-4">
              {/* The toggle replaced the <h2> in the first cut, which took
                  the panel out of the document outline for exactly the
                  viewer with the most in it. The heading stays; the two
                  buttons sit beside it, which is also what the owner asked
                  for ("next to Your Submission"). */}
              <h2 className="mono text-xs uppercase tracking-[0.2em] text-light">
                Submissions
              </h2>
              {/* Both stay MOUNTED and neither ever carries the `disabled`
                  attribute: a disabled or unmounted control blurs focus to
                  <body>, which restarts a keyboard user's next Tab at the top
                  of the whole form. Same rule the pager arrows below follow,
                  for the same reason. */}
              {(["mine", "all"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  className="btn btn--text mono text-xs uppercase tracking-[0.2em]"
                  // aria-pressed ONLY. The first cut also set aria-disabled
                  // on the selected tab, and both .btn[aria-disabled] rules
                  // in futurism.css would then have dimmed it: a segmented
                  // control showing its current choice as the greyed-out
                  // one. switchView already no-ops on re-selection, so there
                  // is nothing to disable, and the lit state is the
                  // .btn--text[aria-pressed="true"] rule.
                  aria-pressed={view === v}
                  onClick={() => switchView(v)}
                >
                  {v === "mine" ? "Your submissions" : "All submissions"}
                </button>
              ))}
              {view === "all" && (
                <button
                  type="button"
                  className="btn btn--text mono text-xs uppercase tracking-[0.2em]"
                  aria-busy={loading}
                  onClick={() => {
                    setLoading(true);
                    void refresh("all");
                  }}
                >
                  Refresh
                </button>
              )}
            </div>
          ) : (
            <h2 className="mono text-xs uppercase tracking-[0.2em] text-light">
              Your submissions
            </h2>
          )}
          {view === "all" && (
            <p className="text-xs text-faint">
              Every submission on the site, newest first, across the Our Work
              page and every company page. This view does not refresh on its
              own; use Refresh to see the latest.
            </p>
          )}
          {/* Rendered in BOTH views. The cap applies to either list, so
              hiding this on the own list leaves the same silently-cut list
              under a total that asserts it is complete. */}
          {truncated && (
            <p className="text-xs text-faint">
              There are more than {WORK_CAPS.submissionListMax} of these; this
              shows the newest {WORK_CAPS.submissionListMax}.
            </p>
          )}
          {notice && (
            <p
              ref={noticeRef}
              role="status"
              tabIndex={-1}
              className="text-sm text-light"
            >
              {notice}
            </p>
          )}
          {error && <p className="text-sm text-red-400">{error}</p>}
          {loading && visible.length === 0 && (
            <p className="text-sm text-faint">Loading submissions.</p>
          )}
          {!loading && visible.length === 0 && (
            <p className="text-sm text-faint">
              {view === "all"
                ? "No submissions yet."
                : "You have no submissions yet."}
            </p>
          )}
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
                {view === "all" && (
                  <>
                    {/* The bare address, matching /admin/work. person-label's
                        rule is not applied to the owner here for the reason
                        its own header gives: the projection carries no real
                        name, and submitter_name is a single first name the
                        rule rejects anyway. */}
                    <span className="text-faint">
                      {r.owner}
                      {isMine(r) ? " (you)" : ""}
                    </span>
                    <span className="badge">
                      {r.lane === "internal"
                        ? "Our Work"
                        : (r.laneName ?? "Company page")}
                    </span>
                    {/* An inventory cannot assume the reader knows what each
                        row is; their own list can. */}
                    <span className="text-faint">
                      {KIND_LABELS[r.kind as WorkKind] ?? r.kind}
                    </span>
                  </>
                )}
                {/* Owner directive 2026-08-25 ("always have the timestamp
                    shown in the timezone of the user when a work was
                    submitted"). The API has always projected createdAt and
                    nothing here ever rendered it, so no submitter-facing
                    surface carried a submitted-at at all (the one stamp in
                    code is the ADMIN archive-retention mail, notify.ts).
                    Placed OUTSIDE the view === "all" fragment on purpose:
                    "always" means both lists, every row, so this must not
                    sit in a branch. LAST in the flex row because it is the
                    widest late-added item, and flex-wrap only pushes items
                    AFTER it: tail-position confines any reflow away from the
                    title and status badge. The visible "Submitted" label is
                    not decoration: the row can already read "Published", and
                    a bare clock next to that chip reads as the publish date,
                    which is a different column (published_at).

                    exact() here, NOT <LocalTime> as on the three server
                    surfaces, and the difference is load-bearing.
                    <LocalTime>'s useState seed is UTC-pinned unconditionally
                    (it is not mounted-aware) and only swaps in a deferred
                    effect; that seed exists to make an SSR'd row hydrate byte
                    for byte. This list has no SSR'd row to match: `rows` is
                    [] on the server and fills only from the poll, so the seed
                    would buy nothing and cost a painted frame of the WRONG
                    zone on every row, on every pager turn and every view
                    switch. exact() formats in the runtime zone on its first
                    render, so a row goes from absent to correct. The settled
                    text is identical: ABS_TIME's option set matches
                    <LocalTime>'s post-mount formatter exactly. The <time>
                    element is written out here because exact() returns a
                    string, keeping the machine-readable instant the other
                    surfaces get from the component. */}
                <span className="mono text-xs text-faint">
                  Submitted <time dateTime={r.createdAt}>{exact(r.createdAt)}</time>
                </span>
              </div>
              {r.movedFrom && (
                <p className="mt-1 text-xs text-faint">
                  Originally submitted by {r.movedFrom}.
                </p>
              )}
              {r.status === "published" && r.slug && (
                <p className="mt-1">
                  {/* The link is LANE-dependent. A company card is not on
                      /work at all (publishedCards filters by scope), so the
                      old unconditional sentence would state a falsehood and
                      hand the admin a dead anchor for every company row the
                      all view surfaces. */}
                  {r.lane === "internal" ? (
                    <>
                      Live on <a href={`/work#${r.slug}`}>the Our Work page</a>.
                    </>
                  ) : (
                    "Live on its company's own Your Work page."
                  )}
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
                  {r.lane === "internal"
                    ? " on the Our Work page"
                    : " on its company's own Your Work page"}{" "}
                  under the same title.
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
              <div className="mt-2 flex flex-wrap gap-4">
                {/* Retry review and Submit an update are suppressed on rows
                    the viewer does not own, and ONLY there. Retry burns one
                    of that row's three daily panel runs, and an approved
                    update makes the UPDATER's row the published one, which
                    would quietly move the card to the admin: the exact
                    confusion this round exists to end. Both remain reachable
                    for a deliberate admin at /admin/work and at
                    /work/submit?update=<id>; this is render-only. */}
                {(r.status === "failed" ||
                  r.status === "received" ||
                  r.stale) &&
                  isMine(r) && (
                    <button
                      type="button"
                      className="btn btn--text"
                      onClick={() => void retry(r.id)}
                    >
                      Retry review
                    </button>
                  )}
                {r.status === "published" && isMine(r) && (
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
                {r.status === "superseded" && r.currentId && isMine(r) && (
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
                {canListAll &&
                  isMine(r) &&
                  r.status !== "published" &&
                  r.status !== "superseded" && (
                    <button
                      type="button"
                      className="btn btn--text"
                      onClick={() => void withdraw(r)}
                    >
                      Withdraw
                    </button>
                  )}
                {/* §5.16 transfer (owner directive 2026-08-09). Offered on
                    every status, including while a review is running: the
                    route refuses a live run with copy that names when to try
                    again, and hiding the control on a transient state is how
                    an affordance goes missing exactly when someone looks for
                    it (the 2026-08-04 "no option to update again" report). */}
                {canTransfer &&
                  isTransferableStatus(r.status) &&
                  r.status === "running" &&
                  !r.stale && (
                    // The route refuses a live run, so the reason belongs
                    // HERE rather than after the address is typed and the
                    // confirm is accepted. The affordance is not hidden, it
                    // is explained; the button returns the moment the run
                    // ends or goes stale.
                    <span className="text-faint">
                      Moving is available once the review finishes
                    </span>
                  )}
                {canTransfer &&
                  isTransferableStatus(r.status) &&
                  !(r.status === "running" && !r.stale) && (
                  <button
                    type="button"
                    className="btn btn--text"
                    aria-expanded={moveOpen === r.id}
                    onClick={() => {
                      setMoveMsg(null);
                      setMoveEmail("");
                      setMoveOpen(moveOpen === r.id ? null : r.id);
                    }}
                  >
                    {moveOpen === r.id ? "Cancel move" : "Move to someone else"}
                  </button>
                )}
              </div>
              {/* Gated on the SAME predicate as the button above it. Without
                  that, a row that flips to superseded under the 10 s poll
                  loses its toggle while an open form stays behind it: no
                  Cancel, and a Move button the route now refuses for good. */}
              {moveOpen === r.id && canTransfer && isTransferableStatus(r.status) && (
                <div className="mt-3 space-y-2">
                  <label
                    htmlFor={`move-${r.id}`}
                    className="mono block text-xs uppercase tracking-[0.2em] text-light"
                  >
                    Move to
                  </label>
                  <div className="flex flex-wrap items-center gap-3">
                    <input
                      id={`move-${r.id}`}
                      type="email"
                      className="input"
                      autoComplete="email"
                      // Type-ahead over known staff, and ONLY on the staff
                      // lane: a company row's people are a different
                      // directory. The list is a convenience; the route's
                      // domain rule is the actual gate, so someone who has
                      // not signed in yet is still a valid target.
                      list={
                        r.lane === "internal" && transferCandidates.length > 0
                          ? "work-transfer-people"
                          : undefined
                      }
                      // The placeholder is the only place an admin learns
                      // which address family a company row will accept; the
                      // route's refusal would otherwise be the first time
                      // they hear it.
                      placeholder={
                        r.lane === "internal"
                          ? // Mirrors WORK_SUBMIT_DOMAINS[0]. Written as a
                            // literal because that constant lives in
                            // work/http.ts, which reaches the session and the
                            // roadmap DB and must never enter a client
                            // bundle; scripts/work-tests.ts pins the two
                            // together so the placeholder cannot drift.
                            "name@xl.net"
                          : r.laneDomain
                            ? `name@${r.laneDomain}`
                            : "their work email"
                      }
                      value={moveEmail}
                      onChange={(e) => setMoveEmail(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          if (!moveBusy) void move(r);
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="btn btn--text"
                      aria-busy={moveBusy}
                      aria-disabled={moveBusy}
                      onClick={() => {
                        if (moveBusy) return;
                        void move(r);
                      }}
                    >
                      Move
                    </button>
                  </div>
                  {moveMsg?.id === r.id && (
                    <p className="text-sm text-red-400">{moveMsg.text}</p>
                  )}
                  <p className="text-xs text-faint">
                    The submission becomes theirs, as though they had
                    submitted it:{" "}
                    {view === "mine" ? "it leaves this list, " : ""}
                    they get every option on it, and they are emailed.
                    {r.lane === "internal"
                      ? ""
                      : ` It belongs to a company page, so it can only move to someone at ${r.laneDomain ?? "that company"}.`}{" "}
                    Nothing is deleted and the card itself does not change: a
                    published card keeps the printed byline it was published
                    under. The scorecard counts published cards by owner, so
                    that count moves with the submission.
                    {r.lane === "internal"
                      ? " The new owner can move it back, and so can Adam."
                      : " Moving it back is an XL.net action: the new owner has no such control on a company page."}
                  </p>
                </div>
              )}
            </div>
          ))}
          {showPager && pagerStrip(true)}
          {!canTransfer && (
            <p className="mt-2 text-xs text-faint">
              Moving a submission to someone else is not available on this
              sign-in, because it needs a sign-in that verified your address.
              Sign out and sign back in with your xl.net account and the
              option appears on each row; if it still does not, sign in with
              Google.
            </p>
          )}
          {!isAdmin && (
            <p className="mt-2 text-xs text-faint">
              A queued review starts on its own as soon as the panel and
              daily capacity are free; Retry review is the manual lever,
              re-running the panel on the files already uploaded, and it
              cannot pick up a replacement file. To ship a new version of
              a card that already published, use Submit an update on its
              row: the update is reviewed like any submission, and the live
              card only changes after Adam approves it.{" "}
              {canTransfer
                ? "If a submission should belong to someone else, Move to someone else on its row hands it over: it becomes theirs, they get its emails and its options, and a published card stays on the Our Work page exactly as it is. "
                : ""}
              If you submitted the
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
