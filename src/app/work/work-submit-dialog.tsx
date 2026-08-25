"use client";

// The /work submission dialog (§5.16): a native <dialog> wrapping the shared
// <SubmissionForm>. Loaded lazily by StaffSubmitEntry only after the session
// probe confirms staff, so the public /work bundle never carries the form.
//
// Close semantics (panel + critic rulings): X and Cancel close; Esc closes
// unless an upload is in flight (best-effort preventDefault on the cancel
// event; browsers may bypass a repeated Esc, so closing is NON-destructive:
// the dialog stays mounted and form state survives, reopening restores the
// draft or the post-submit notice). No backdrop-click close: the hand-rolled
// detection false-fires on drag-selects out of the big textarea.

import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { EMAIL_PROMISE } from "@/lib/work/config";
import { SubmissionForm } from "./submit/submission-form";

export interface WorkSubmitDialogHandle {
  open: () => void;
}

export interface WorkSubmitDialogProps {
  /** §5.18 company reuse: copy overrides with staff defaults, so every
   * /work usage stays byte-identical. */
  intro?: string;
  trackHref?: string;
  creditTeamName?: string;
  retentionLine?: string;
  /** Which lane the live tracker's copy speaks for. Explicit, never inferred
   * from trackHref: company copy must never name Adam, /admin or
   * /work/submit. */
  lane?: "internal" | "company";
}

export const WorkSubmitDialog = forwardRef<
  WorkSubmitDialogHandle,
  WorkSubmitDialogProps
>(function WorkSubmitDialog(props, ref) {
    const dialogRef = useRef<HTMLDialogElement>(null);
    const busyRef = useRef(false);
    const [, setBusyTick] = useState(false);

    useImperativeHandle(ref, () => ({
      open: () => {
        const d = dialogRef.current;
        if (d && !d.open) d.showModal();
      },
    }));

    const close = () => dialogRef.current?.close();

    return (
      <dialog
        ref={dialogRef}
        className="work-dialog"
        aria-labelledby="work-dialog-title"
        onCancel={(e) => {
          if (busyRef.current) e.preventDefault();
        }}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <span className="sys-label">Our Work / Submit Your Build</span>
            <h2 id="work-dialog-title" className="mt-2 text-xl font-bold">
              Submit a tool you built
            </h2>
          </div>
          <button
            type="button"
            className="btn btn--text"
            aria-label="Close"
            onClick={close}
          >
            ✕
          </button>
        </div>
        <p className="mt-3 text-sm text-faint">
          {props.intro ??
            `An automated editorial panel drafts a /work card from your documents, argues against it, and publishes only what it can verify. ${EMAIL_PROMISE}`}
        </p>
        <div className="mt-6">
          <SubmissionForm
            context="dialog"
            onClose={close}
            onBusyChange={(b) => {
              busyRef.current = b;
              setBusyTick(b);
            }}
            trackHref={props.trackHref}
            creditTeamName={props.creditTeamName}
            retentionLine={props.retentionLine}
            lane={props.lane}
          />
        </div>
      </dialog>
    );
  }
);
