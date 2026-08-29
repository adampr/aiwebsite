"use client";

// Client islands for roadmap step 3 (§5.18): the submit entry that opens
// the SHARED /work submission dialog (same form, same validation; company
// copy rides in through the dialog's optional props), the Retry button for
// the viewer's own failed submissions, and the "time saved per month"
// editor on the viewer's own rows. The server gates every submit, retry and
// edit regardless of what renders here.
//
// COMPANY COPY RULE, and it applies to every string in this file: a reader
// here is a member of a client company, not staff. Nothing may name Adam,
// /work, /work/submit or /admin - none of those are pages they can open, and
// naming them turns an instruction into a dead end.

import { lazy, Suspense, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { EMAIL_PROMISE } from "@/lib/work/config";
import {
  formatTimeSavedPhrase,
  hoursFieldValue,
  TIME_SAVED_MAX_HOURS,
} from "@/lib/work/time-saved";
import type { WorkSubmitDialogHandle } from "@/app/work/work-submit-dialog";

const LazyDialog = lazy(() =>
  import("@/app/work/work-submit-dialog").then((m) => ({
    default: m.WorkSubmitDialog,
  }))
);

const LazyProgress = lazy(() =>
  import("@/app/work/submit/review-progress").then((m) => ({
    default: m.ReviewProgress,
  }))
);

/** Live progress for one In Review row on this SERVER-rendered page. Self
 * fetch mode: there is no list poll here to feed it, so the tracker polls
 * GET /api/work/submissions/{id} itself. lane="company" is what keeps the
 * terminal and next-step copy off Adam, /admin and /work/submit, none of
 * which a client reader can act on. Lazy for the same reason the dialog is:
 * the roadmap bundle should not carry it until a row needs it. */
export function SubmissionProgress({ id }: { id: string }) {
  return (
    <Suspense fallback={null}>
      <LazyProgress id={id} lane="company" />
    </Suspense>
  );
}

export function RoadmapSubmitEntry({ orgName }: { orgName: string }) {
  const [wantDialog, setWantDialog] = useState(false);
  const dialogRef = useRef<WorkSubmitDialogHandle>(null);
  const pendingOpen = useRef(false);

  return (
    <div>
      <button
        type="button"
        className="btn btn--primary"
        aria-haspopup="dialog"
        onClick={() => {
          pendingOpen.current = true;
          setWantDialog(true);
          dialogRef.current?.open();
        }}
      >
        Submit a build
      </button>
      {wantDialog && (
        <Suspense fallback={null}>
          <LazyDialog
            ref={(h: WorkSubmitDialogHandle | null) => {
              dialogRef.current = h;
              if (h && pendingOpen.current) {
                pendingOpen.current = false;
                h.open();
              }
            }}
            intro={`An automated editorial panel drafts a card from your documents, argues against it, and publishes only what it can verify to your company's private page. ${EMAIL_PROMISE}`}
            lane="company"
            trackHref="/roadmap/work"
            creditTeamName={`the ${orgName} team`}
            retentionLine="Files that look like credentials are cleaned out of your upload before it is stored. Only document text is kept for review; the files are emailed to the XL.net team when the card publishes."
          />
        </Suspense>
      )}
    </div>
  );
}

export function RetrySubmission({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function retry() {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`/api/work/submissions/${id}/retry`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => null)) as {
        status?: string;
        error?: { message?: string };
      } | null;
      if (res.ok) {
        // The route returns ok only when a run actually started, so the
        // note states the running state, never "re-queued".
        setNote("The panel is reviewing again.");
        router.refresh();
        return;
      }
      setNote(
        data?.error?.message ?? "Something went wrong. Try again shortly."
      );
    } catch {
      setNote("Something went wrong. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-3">
      <button
        type="button"
        className="btn btn--text"
        disabled={busy}
        aria-busy={busy}
        onClick={retry}
      >
        {busy ? "Retrying..." : "Retry"}
      </button>
      {note && (
        <span role="status" className="text-xs text-faint">
          {note}
        </span>
      )}
    </span>
  );
}

/** §5.16 time saved per month (owner ask 2026-08-27), the "afterwards"
 * lane on a company member's own submission row.
 *
 * The same behaviour as the editor on /work/submit, deliberately: one route,
 * one parser, one set of refusal sentences, so a company submitter and a
 * staff submitter cannot be told different things about the same number.
 * What differs is only what surrounds it - this page is SERVER-rendered and
 * force-dynamic, so the save ends in router.refresh() rather than in a list
 * poll, and the copy names no XL.net-only page.
 *
 * Offered on every status the row can be in, published included: the honest
 * answer to "how much time does this save you a month" is usually known only
 * after the tool has been in use for a month, so the published row is the
 * one people come back to fill in. */
export function TimeSavedEditor({
  id,
  title,
  status,
  minutes,
}: {
  id: string;
  /** The submission's title, for the toggle's accessible name ONLY. A member
   * with five rows otherwise meets five buttons all named "Edit", which is
   * exactly the state a screen reader's button list makes unusable. The
   * visible label stays short because it sits inside a line that already
   * names the row; the announced one cannot borrow that context. Precedent:
   * CountCell's sr-only suffix on the scorecard. */
  title: string;
  /** The row's status, for ONE decision: a superseded row gets no editor.
   * Nothing reads its figure (the company card list and the scorecard both
   * select status = 'published', which is also what stops a card and the
   * generation it replaced from counting twice), so an Add control there
   * would take a number, confirm it was saved, and send it nowhere.
   * DEFENSIVE on this page rather than live: the list is not status-filtered
   * (mySubmissions selects every row the person owns), but a COMPANY row can
   * never reach "superseded" at all - migration 0035's
   * work_sub_company_no_update_ck forbids a company row with a parent_id,
   * the update route refuses company parents, and publishWithSupersede
   * re-checks both lanes inside its transaction. The branch exists so this
   * island stays correct if the shared list is ever pointed at the staff
   * lane, where superseded rows are ordinary. */
  status: string;
  minutes: number | null;
}) {
  const router = useRouter();
  // undefined = "nothing saved here yet, trust the server prop". A plain
  // useState(minutes) would freeze the FIRST prop forever (React does not
  // re-seed state from a changed prop), so a router.refresh() triggered by
  // anything else on the page would leave this island showing a stale
  // figure. After a save the override and the refreshed prop agree.
  const [override, setOverride] = useState<number | null | undefined>(
    undefined
  );
  const current = override === undefined ? minutes : override;
  const [open, setOpen] = useState(false);
  const [hours, setHours] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(
    null
  );
  // Focus goes back to this toggle when a save closes the editor, because the
  // Save button that was pressed unmounts with it and focus would otherwise
  // fall to <body>, restarting the reader's next Tab at the top of the page.
  const toggleRef = useRef<HTMLButtonElement>(null);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/work/submissions/${id}/time-saved`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The raw string, trimmed. The route owns the one parse: it is what
        // decides that "" and "0" both mean "not reported" and that "6.5"
        // means 390 minutes.
        body: JSON.stringify({ hours: hours.trim() }),
      });
      const data = (await res.json().catch(() => null)) as {
        timeSavedMinutes?: number | null;
        error?: { message?: string };
      } | null;
      if (!res.ok) {
        // Verbatim: the refusals name the ceiling or say to leave it empty,
        // and a generic "that failed" would throw the instruction away. The
        // editor stays OPEN so the refused value is still there to correct.
        setMsg({
          text: data?.error?.message ?? "That did not save. Try again.",
          error: true,
        });
        return;
      }
      // The STORED minutes, not the typed hours: the parser rounds and
      // clamps, so echoing the input could paint a figure no row holds.
      const saved = data?.timeSavedMinutes ?? null;
      setOverride(saved);
      setOpen(false);
      const phrase = formatTimeSavedPhrase(saved);
      setMsg({
        text: phrase
          ? `Saved. This submission reports ${phrase}.`
          : "Saved. This submission no longer reports a time saved.",
        error: false,
      });
      requestAnimationFrame(() => toggleRef.current?.focus());
      // The page is force-dynamic and server-rendered: the published card
      // further down this same page prints this figure, so a refresh is what
      // keeps the card and the row from disagreeing.
      router.refresh();
    } catch {
      setMsg({
        text: "That did not save. Check your connection and try again.",
        error: true,
      });
    } finally {
      setBusy(false);
    }
  }

  // Superseded: the figure if there is one, and nothing to press. AFTER every
  // hook above, so the rules-of-hooks order is identical on both branches.
  // The read-only line is not decoration: this row is where a member looks
  // for the submission they remember making, and a figure that vanished with
  // no explanation reads as data loss. The sentence says where the number
  // that counts lives now; the row's own status badge already says the rest.
  if (status === "superseded") {
    if ((current ?? 0) <= 0) return null;
    return (
      <span className="inline-flex flex-wrap items-center gap-3">
        <span className="mono text-xs text-faint">
          Time saved · {formatTimeSavedPhrase(current)}, as reported on this
          version
        </span>
        {/* Word for word what /work/submit says on a superseded row, and
            conditional for the reason given there: a swap between two
            different people publishes the new version with no figure, so
            promising that the live version "carries its own" can be false at
            the moment someone reads it. */}
        <span className="text-xs text-faint">
          Nothing reads this figure now. Whatever the live version reports is
          what the card and the scorecard show.
        </span>
      </span>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-3">
      <span className="mono text-xs text-faint">
        {/* "not reported" rather than "0": a zero would read as a claim that
            the work saves no time, which is a different statement from
            having no figure yet. */}
        Time saved · {formatTimeSavedPhrase(current) ?? "not reported"}
      </span>
      <button
        type="button"
        className="btn btn--text"
        ref={toggleRef}
        aria-expanded={open}
        onClick={() => {
          setMsg(null);
          if (open) {
            setOpen(false);
            return;
          }
          // Pre-filled with the current figure, so a small correction is an
          // edit rather than a re-entry from memory. hoursFieldValue is the
          // inverse of the parser and rounds to 2 decimals, so the field
          // opens with a value the parser reads back unchanged.
          setHours(hoursFieldValue(current));
          setOpen(true);
        }}
      >
        {/* "> 0", not "!== null": migration 0049's CHECK starts at 1 minute
            so there is exactly one spelling of "nothing reported", and a
            stray 0 must read the same way here as the formatter reads it. */}
        {open ? "Cancel edit" : (current ?? 0) > 0 ? "Edit" : "Add"}
        {/* Announced, not shown: see the `title` prop above for why a bare
            "Edit" is not a usable button name on a list of five rows. */}
        <span className="sr-only"> time saved for {title}</span>
      </button>
      {open && (
        <>
          <label
            htmlFor={`time-saved-${id}`}
            className="mono text-xs uppercase tracking-[0.2em] text-light"
          >
            Hours a month
          </label>
          <input
            id={`time-saved-${id}`}
            type="number"
            // A phone keypad with no decimal point makes "6.5" untypeable,
            // and "about six and a half" is the most common answer here.
            inputMode="decimal"
            min={0}
            // The constant, not a literal: the parser and the 0049 CHECK
            // share this ceiling, and a hand-typed one here would drift into
            // a field that accepts a value the route then refuses.
            max={TIME_SAVED_MAX_HOURS}
            // "any", not a step grid. Nothing here is inside a <form>, so
            // the browser never refuses this field, but the same number typed
            // into the submission dialog on this page WOULD be refused there
            // on a 0.25 grid (6.3: "the two nearest valid values are 6.25 and
            // 6.5"). One figure, two write moments, and they must not
            // disagree about what counts as valid. The parser is the single
            // arbiter; min and max stay because they agree with it exactly.
            step="any"
            className="input w-24"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (!busy) void save();
              }
            }}
            placeholder="6.5"
          />
          <button
            type="button"
            className="btn btn--text"
            // aria-disabled, never the `disabled` attribute: a control that
            // disables itself mid-save blurs to <body>. The handler no-ops
            // instead, so a double press cannot fire a second POST.
            aria-busy={busy}
            aria-disabled={busy}
            onClick={() => {
              if (busy) return;
              void save();
            }}
          >
            {busy ? "Saving..." : "Save"}
          </button>
          <span className="text-xs text-faint">
            {/* "Once your card is published" is load-bearing, not hedging:
                this editor renders on rows that are still in review, held or
                failed, where there is no card yet and the scorecard (which
                counts published rows only) counts nothing. The old copy
                asserted both outright. Hours, any hours: the parser takes
                0.75 as readily as 6, and step="any" above now says so too. */}
            Your own estimate in hours; 6, 6.5 and 0.75 all work. Once your
            card is published the figure shows on it, reported by you, and
            counts on your scorecard. Enter 0 to remove it.
          </span>
        </>
      )}
      {msg && (
        <span
          // A refusal interrupts; a confirmation waits its turn.
          role={msg.error ? "alert" : "status"}
          className={msg.error ? "text-xs text-red-400" : "text-xs text-faint"}
        >
          {msg.text}
        </span>
      )}
    </span>
  );
}
