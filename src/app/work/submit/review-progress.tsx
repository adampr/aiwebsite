"use client";

// §5.16 live review tracker (2026-08-25 round). ONE component, rendered in
// three places: the "your submissions" list on /work/submit, the shared
// submit dialog on /work and /roadmap/work, and the In Review list on
// /roadmap/work. Before this existed, the dialog said "Track it on your
// submissions page" and that page was a server-rendered badge that changed
// only on a manual reload, which is what the 2026-08-25 complaint was about.
//
// Two modes, and the distinction is a cost decision, not a style one:
//   PARENT-FED (`row`): submit-client already polls the list every 10 s, so
//     this component must never open a second request per row.
//   SELF-FETCH (`id`): the dialog and the roadmap page have no list poll of
//     their own, so the component polls GET /api/work/submissions/{id}.
//
// The elapsed clock is SERVER-ANCHORED: each poll stores {elapsedMs, the
// local instant it arrived} and the one-second ticker adds the local delta
// since. The one number this tracker promises is honest must never be a
// client clock minus a server instant, because a laptop two minutes behind
// would render a negative age (formatElapsed clamps it, but the number would
// still be wrong).
//
// No focus management anywhere in here, deliberately. The live region below
// announces on its own, and focusing an element that is itself role="status"
// makes screen readers announce it twice.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  FAILED_NEXT_STEPS,
  formatElapsed,
  isTerminalWorkStatus,
  PANEL_STAGES,
  queueWaitCopy,
  WORK_POLL_MS,
  workStageLine,
  workTerminalLine,
} from "@/lib/work/config";

/** Exactly the fields the tracker reads off SubmissionStatusView. Written out
 * rather than imported from view.ts so this client component never pulls the
 * server projection module (and its db.ts types) into the browser bundle. */
export interface TrackerRow {
  status: string;
  /** The RAW stage name, formatted here by workStageLine(). */
  stage: string | null;
  stageIndex: number | null;
  stageCount: number | null;
  elapsedMs: number | null;
  serverNowMs: number;
  waiting: boolean;
  slow: boolean;
  stale: boolean;
  queueReason: string | null;
  error: string | null;
}

interface Anchor {
  elapsedMs: number;
  atLocalMs: number;
}

export function ReviewProgress({
  row = null,
  id,
  lane,
  initialQueueReason = null,
  canRetry = false,
}: {
  row?: TrackerRow | null;
  id?: string;
  lane: "internal" | "company";
  /** Does the surface rendering this tracker actually show a "Retry review"
   * control for a stale running row? Only /work/submit does, so it defaults
   * to false and the stale sentence names no control anywhere else. */
  canRetry?: boolean;
  /** The refusal reason the 202 body already carried, so the FIRST second of
   * the dialog reads correctly, before any poll has run. */
  initialQueueReason?: string | null;
}) {
  const [fetched, setFetched] = useState<TrackerRow | null>(null);
  // A parent-fed row wins whenever it is given: the list poll is the cheaper
  // source and a second one would double the read cost per row.
  const data = row ?? fetched;
  const selfFetch = !row && !!id;
  const terminal = !!data && isTerminalWorkStatus(data.status);

  const elapsedFromServer = data?.elapsedMs ?? null;
  const serverNowMs = data?.serverNowMs ?? 0;
  // The anchor is a REF, and the displayed number is state the one-second
  // ticker writes. Both halves are deliberate: re-anchoring is a write, so it
  // must not cascade a render, and Date.now() is impure, so it must not be
  // read while rendering. Everything time-shaped therefore happens in an
  // effect or a timer callback, never in the render body.
  const anchorRef = useRef<Anchor | null>(null);
  const [shownElapsedMs, setShownElapsedMs] = useState<number | null>(
    row?.elapsedMs ?? null
  );
  useEffect(() => {
    anchorRef.current =
      elapsedFromServer === null
        ? null
        : { elapsedMs: elapsedFromServer, atLocalMs: Date.now() };
    // serverNowMs is in the dependency list on purpose: two consecutive polls
    // one second apart can report the SAME elapsedMs after flooring, and the
    // anchor still has to move, or the local delta double-counts.
  }, [elapsedFromServer, serverNowMs]);

  const load = useCallback(async () => {
    if (!id) return WORK_POLL_MS;
    try {
      const res = await fetch(`/api/work/submissions/${id}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        // The poll bucket is work:poll, 30 per 60 s per user, and one open
        // dialog already spends 6 of them a minute. A refusal must back off,
        // not hammer the bucket that produced it.
        return WORK_POLL_MS * 2;
      }
      const body = (await res.json()) as { submission?: TrackerRow } | null;
      if (body?.submission) setFetched(body.submission);
      return WORK_POLL_MS;
    } catch {
      // A dropped tick costs nothing; the next one recovers.
      return WORK_POLL_MS;
    }
  }, [id]);

  useEffect(() => {
    if (!selfFetch || terminal) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    // A self-rescheduling timeout rather than setInterval, because the wait
    // has to be able to double after a refusal and a fixed interval cannot.
    // The first delay is 0, so the tracker has real data within a frame of
    // mounting rather than ten seconds later; the fetch still happens in a
    // timer callback rather than in this effect's body.
    const schedule = (delayMs: number) => {
      timer = setTimeout(async () => {
        let nextMs = WORK_POLL_MS;
        // A hidden tab is skipped, not stopped: the visibilitychange handler
        // below fires one immediate refresh when the reader comes back, so
        // returning to a tab never shows a minutes-old step line.
        if (!cancelled && document.visibilityState !== "hidden")
          nextMs = await load();
        if (!cancelled) schedule(nextMs);
      }, delayMs);
    };
    schedule(0);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [selfFetch, terminal, load]);

  useEffect(() => {
    if (terminal) return;
    // The per-second ticker exists so the clock MOVES between polls: a number
    // that does not move is indistinguishable from a dead page, which is the
    // whole complaint this round answers. It advances the SERVER's number by
    // the local delta since that number arrived, so the one figure this
    // tracker promises is honest is never a client clock minus a server
    // instant (a laptop two minutes behind would otherwise count backwards).
    const t = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      const a = anchorRef.current;
      setShownElapsedMs(
        a === null ? null : a.elapsedMs + Math.max(0, Date.now() - a.atLocalMs)
      );
    }, 1000);
    return () => clearInterval(t);
  }, [terminal]);

  if (!data) return null;

  // Before the first tick, the server's own figure stands in, so a freshly
  // mounted tracker shows a real age instead of a blank for one second.
  const elapsedMs = shownElapsedMs ?? elapsedFromServer;

  // SLOT 1, the ONLY live region on this component, and exactly one sentence.
  //
  // It is recomputed on every one-second tick, but its TEXT only changes on a
  // meaningful change: the status, the step, the slow flag, or a whole minute
  // rolling over. React commits a text node only when the string differs, so
  // an unchanged 10 s poll and the 1 s ticker never mutate the DOM and never
  // re-announce. The minute phrase is deliberately INSIDE the region while
  // the per-second clock is deliberately outside it: a screen-reader user's
  // only progress signal would otherwise be one sentence per stage, which on
  // the measured incident was ten minutes of silence during exactly the stall
  // this round exists to fix.
  let sentence = "";
  if (terminal) {
    sentence = data.error || workTerminalLine(data.status, lane);
  } else if (data.status === "received") {
    sentence = `${queueWaitCopy(data.queueReason ?? initialQueueReason)} Nothing for you to do.`;
  } else if (data.stale) {
    // Lane-blind and surface-blind on purpose (counterpart-panel finding,
    // 2026-08-25). This component renders in three places and only
    // /work/submit offers a "Retry review" control on a stale RUNNING row:
    // /roadmap/work renders its retry only for failed or received rows and
    // labels it "Retry", and neither dialog has one at all. Naming a control
    // the reader cannot see was the same false sentence twice over, so the
    // shared line states the fact and `canRetry` adds the pointer only where
    // the button actually exists.
    sentence = canRetry
      ? "This review stopped responding. Retry review starts it again on the files you already uploaded."
      : "This review stopped responding. Nothing was lost.";
  } else {
    sentence = workStageLine(data.stage, data.stageIndex, data.stageCount);
    if (data.slow)
      sentence +=
        " This step is taking longer than most. The review is still going.";
    if (elapsedMs !== null && elapsedMs >= 60_000) {
      const minutes = Math.round(elapsedMs / 60_000);
      sentence += ` About ${minutes} minute${minutes === 1 ? "" : "s"} so far.`;
    }
  }

  // SLOT 2. ALL NINE SEGMENTS FILL ON ANY TERMINAL STATUS, so a held, failed,
  // superseded or waiting-for-approval row never leaves empty segments
  // asserting a review that never finished. No percentage anywhere: stages 8
  // and 9 are conditional, so a clean run publishes after 7 and a percentage
  // would be wrong in both directions.
  const filled = terminal
    ? PANEL_STAGES.length
    : Math.min(PANEL_STAGES.length, (data.stageIndex ?? 0) + 1);

  return (
    <div className="mt-2 space-y-2">
      <p role="status" aria-live="polite" aria-atomic="true" className="text-sm text-light">
        {sentence}
      </p>
      <div className="flex gap-1" aria-hidden="true">
        {PANEL_STAGES.map((stage, i) => (
          <span
            key={stage}
            className="h-1 flex-1 rounded-full"
            style={{
              backgroundColor:
                i < filled ? "var(--xl-light)" : "var(--xl-line)",
            }}
          />
        ))}
      </div>
      {!terminal && elapsedMs !== null && (
        <p className="mono text-xs text-faint" aria-hidden="true">
          {data.status === "received"
            ? `In the queue for ${formatElapsed(elapsedMs)}`
            : `Running for ${formatElapsed(elapsedMs)}`}
        </p>
      )}
      {!terminal && (
        // NO duration band here on purpose. "Most take 4 to 15 minutes" was
        // proposed and cut: it is an ETA from three measurements on one day,
        // it excludes the queue wait entirely, and this same change
        // deliberately makes runs longer, so a 22 minute run would be told by
        // our own caption that it is abnormal.
        <p className="text-xs text-faint">
          Not every review needs all nine steps, so many finish sooner.
        </p>
      )}
      {data.status === "failed" && (
        <p className="text-sm text-faint">{FAILED_NEXT_STEPS[lane]}</p>
      )}
    </div>
  );
}
