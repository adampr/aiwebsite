"use client";

// Format-sample control (§5.12): shows whether a format sample is attached
// and lets the user add, replace, or remove one. Self-contained fetches; the
// host passes an optional onAnnounce wired to the workspace's single polite
// live region for success feedback, and onChanged so the host can refetch
// the project view (keeping other instances in sync). Errors render as
// role="alert" text, the one assertive exception (an upload failing silently
// reads as success). `disabled` locks add/replace only, and `removeOnly`
// hides them entirely (final projects): removing user data always works.
//
// Owner rule 2026-07-17: a new sample reformats the whole draft immediately.
// When the host passes onUploaded/onRemoved, it owns the post-upload story
// (auto-run, queueing, announcements); this component only reports the event.
// Without them (research screen, nothing drafted yet) it announces locally.

import { useId, useRef, useState } from "react";
import {
  STYLE_SAMPLE_ACCEPT,
  STYLE_SAMPLE_HELPER,
  styleSampleFileError,
} from "@/lib/governance/config";
import type { NumberingStyle } from "@/lib/governance/numbering";
import { apiUpload, api, WorkingRow } from "./shared";

/** Specimen items and the spoken equivalent per detected numbering style
 *  (round 15d transparency line). Specimens are visual (mono, per-item
 *  nowrap so wraps land between items, aria-hidden); the sr-only text is
 *  the exact spoken form (mono "I. II. III." reads as gibberish). */
const NUMBERING_SPECIMENS: Record<
  NumberingStyle,
  { items: string[]; spoken: string }
> = {
  decimal: { items: ["1.", "2.", "3."], spoken: "numbered 1, 2, 3" },
  "decimal-zero": {
    items: ["1.0", "2.0", "3.0"],
    spoken: "numbered 1.0, 2.0, 3.0",
  },
  paren: { items: ["1)", "2)", "3)"], spoken: "numbered 1, 2, 3 with parentheses" },
  roman: { items: ["I.", "II.", "III."], spoken: "numbered with roman numerals" },
  alpha: { items: ["A.", "B.", "C."], spoken: "lettered A, B, C" },
  "section-word": {
    items: ["Section 1:", "Section 2:", "Section 3:"],
    spoken: "titled Section 1, Section 2, Section 3",
  },
};

const faint = { color: "var(--xl-text-faint)" } as const;
const dim = { color: "var(--xl-text-dim)" } as const;

/** Reformat-the-draft wiring (§5.12 restyle run), owned by the workspace:
 *  available = a sample is attached, the project is drafting or in review,
 *  and at least one section is drafted. One consent contract in every state:
 *  queued has Skip, running has Stop; both mean "no more restyling". */
export interface ReformatControl {
  available: boolean;
  busy: boolean; // a reformat run is active (covers the gaps between passes)
  stopping: boolean; // Stop pressed; the pass in flight finishes first
  queued: boolean; // auto-run waiting for the current turn to land
  long: boolean;
  locked: boolean; // any turn in flight, feature disabled, or brain down
  passNote: string; // "" or "Pass 2 of 4." while a multi-pass run advances
  onStart: () => void;
  onStop: () => void;
  onSkipQueued: () => void;
}

export function StyleSampleControl({
  projectId,
  initialName,
  disabled,
  removeOnly = false,
  note,
  reformat,
  onAnnounce,
  onChanged,
  onUploaded,
  onRemoved,
  numbering,
}: {
  projectId: string;
  initialName: string | null;
  disabled: boolean;
  removeOnly?: boolean;
  note?: string;
  reformat?: ReformatControl;
  onAnnounce?: (text: string) => void;
  onChanged?: () => void;
  onUploaded?: (name: string) => void;
  onRemoved?: () => void;
  // The sample's detected numbering style, from the VIEW (the one source
  // of truth the doc pane renders from). undefined = host does not surface
  // it (research screen); null = sample attached, nothing detected.
  numbering?: NumberingStyle | null;
}) {
  const [name, setName] = useState<string | null>(initialName);
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const runNoteId = useId();

  // Designer/critic panel 2026-07-17: while a reformat is queued or running,
  // Replace and Remove stay ENABLED (a mid-run replace supersedes the run,
  // a remove stops it; both land safely at a pass boundary). What changes is
  // the fine print: the standing upload guidance swaps for one line that
  // states the consequence and routes stop/skip intent to the dedicated
  // Stop/Skip controls instead of the destructive Remove. Both buttons get
  // aria-describedby to this line so screen readers hear it pre-activation.
  // With the sample gone mid-run (removed here or in another tab) the
  // replace-and-keep sentence would point at buttons that no longer render,
  // so it only speaks while a sample exists; a latched stop after removal
  // gets its own honest line instead.
  const runNote =
    !removeOnly && reformat
      ? reformat.queued && name
        ? "A new sample takes this one's place. To keep the sample and skip the reformat, use Skip the reformat."
        : reformat.busy
          ? name
            ? "Replacing the sample starts the reformat over with the new one. To stop reformatting and keep the sample, use Stop reformatting."
            : reformat.stopping
              ? "The reformat of the removed sample is ending; what is done so far is kept."
              : ""
          : ""
      : "";

  // Adopt server-driven changes (another tab, a fresh poll) without losing
  // local updates: the documented adjust-state-during-render pattern.
  const [prevInitial, setPrevInitial] = useState(initialName);
  if (prevInitial !== initialName) {
    setPrevInitial(initialName);
    setName(initialName);
  }

  async function upload(file: File) {
    const precheck = styleSampleFileError(file.name, file.size);
    if (precheck) {
      setError(precheck);
      return;
    }
    setBusy("upload");
    setError("");
    const form = new FormData();
    form.append("file", file);
    const r = await apiUpload<{ styleSample: { name: string } }>(
      `/api/governance/projects/${encodeURIComponent(projectId)}/style-sample`,
      form
    );
    setBusy(null);
    if (r.ok) {
      setName(r.data.styleSample.name);
      // The host composes the one announcement (attached + numbering +
      // what happens next) FROM ITS OWN REFETCHED VIEW : the single source
      // of truth the doc pane renders from : so it fetches itself;
      // announcing or fetching here too would double both.
      if (onUploaded) onUploaded(r.data.styleSample.name);
      else {
        onChanged?.();
        onAnnounce?.(`Format sample attached: ${r.data.styleSample.name}.`);
      }
    } else setError(r.message);
  }

  async function remove() {
    setBusy("remove");
    setError("");
    const r = await api<undefined>(
      `/api/governance/projects/${encodeURIComponent(projectId)}/style-sample`,
      { method: "DELETE" }
    );
    setBusy(null);
    if (r.ok || r.status === 404) {
      setName(null);
      onChanged?.();
      if (onRemoved) onRemoved();
      else onAnnounce?.("Format sample removed.");
    } else setError(r.message);
  }

  // In remove-only mode with nothing attached there is nothing to show.
  if (removeOnly && !name) return null;

  return (
    <div className="mt-4 text-left text-sm">
      <input
        ref={inputRef}
        type="file"
        accept={STYLE_SAMPLE_ACCEPT}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void upload(f);
        }}
      />
      {/* Status line and actions are separate rows: a long filename wraps on
          its own without the buttons interleaving mid-wrap. */}
      <p className="max-w-none" style={dim}>
        {name ? (
          <>
            Format sample: <span className="mono break-words">{name}</span>
          </>
        ) : (
          "No format sample attached."
        )}
      </p>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        {!removeOnly && (
          <button
            type="button"
            className="btn btn--text"
            disabled={busy !== null || disabled}
            aria-describedby={runNote && name ? runNoteId : undefined}
            aria-label={
              busy === "upload"
                ? "Uploading format sample"
                : name
                  ? "Replace format sample"
                  : undefined
            }
            onClick={() => inputRef.current?.click()}
          >
            {busy === "upload"
              ? "Uploading..."
              : name
                ? "Replace"
                : "Add a format sample"}
          </button>
        )}
        {name && (
          <button
            type="button"
            className="btn btn--text"
            disabled={busy !== null}
            aria-describedby={runNote && name ? runNoteId : undefined}
            aria-label={
              busy === "remove"
                ? "Removing format sample"
                : "Remove format sample"
            }
            onClick={() => void remove()}
          >
            {busy === "remove" ? "Removing..." : "Remove"}
          </button>
        )}
      </div>
      {/* Numbering transparency line (round 15d): states what the DRAFT
          does now, not a fact about the file. Placed after the actions row
          so a wrapping specimen never shifts the buttons. Static text in
          reading order; changes ride the composed live-region sentence. */}
      {name && numbering !== undefined && (
        <p className="mt-1 max-w-none text-xs" style={dim}>
          {numbering ? (
            <>
              Sections are numbered like the sample:{" "}
              <span aria-hidden="true">
                {NUMBERING_SPECIMENS[numbering].items.map((it) => (
                  <span
                    key={it}
                    className="mono"
                    style={{ whiteSpace: "nowrap", marginRight: "0.75em" }}
                  >
                    {it}
                  </span>
                ))}
              </span>
              <span className="sr-only">
                {NUMBERING_SPECIMENS[numbering].spoken}
              </span>
            </>
          ) : (
            "I did not find a numbering style in this sample, so sections keep the standard 1, 2, 3. Typed numbers in the sample's headings are what I can follow."
          )}
        </p>
      )}
      {reformat?.queued && (
        <div
          className="mt-3 border p-4"
          style={{ borderColor: "var(--xl-line-bright)" }}
        >
          <p className="max-w-none text-sm">
            I will reformat the whole draft to match this sample as soon as
            the current change lands.
          </p>
          <button
            type="button"
            className="btn btn--text mt-3"
            onClick={reformat.onSkipQueued}
          >
            Skip the reformat
          </button>
        </div>
      )}
      {/* This is the page's ONE "Stop reformatting" button (round 15e: the
          question/review pane's pause note now points here instead of
          duplicating it). Run-gated, NOT name-gated: the button governs the
          RUN, which outlives the sample row after a mid-run removal (local
          or another tab's); only the idle start button needs the sample. */}
      {reformat?.busy && !reformat.queued && !removeOnly && (
        <div className="mt-2 flex flex-wrap items-baseline gap-x-6 gap-y-1">
          {reformat.passNote && (
            <span className="text-xs" style={faint}>
              {reformat.passNote}
            </span>
          )}
          {/* Not disabled while stopping: flipping disabled under focus
              drops focus to body, and requestStopRestyle's stopRequested
              guard already makes a second click a no-op. */}
          <button
            type="button"
            className="btn btn--text"
            aria-busy={reformat.stopping || undefined}
            onClick={reformat.onStop}
          >
            {reformat.stopping ? "Stopping..." : "Stop reformatting"}
          </button>
        </div>
      )}
      {name &&
        reformat?.available &&
        !reformat.busy &&
        !reformat.queued &&
        !removeOnly && (
          <div className="mt-2 flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <button
              type="button"
              className="btn btn--text btn--stable"
              disabled={reformat.locked}
              onClick={reformat.onStart}
            >
              Reformat the whole draft
            </button>
          </div>
        )}
      {reformat?.busy && <WorkingRow long={reformat.long} kind="restyle" />}
      {/* One faint line at a time: while a reformat is queued or running the
          run note takes the helper's slot (upload guidance is dead weight
          mid-run, and two same-styled paragraphs read as one blur). The
          standing helper returns in the same position when the run ends. */}
      {!removeOnly &&
        (runNote ? (
          <p
            id={runNoteId}
            data-qa="style-sample-run-note"
            className="mt-1 max-w-none text-xs"
            style={faint}
          >
            {runNote}
          </p>
        ) : (
          <p className="mt-1 max-w-none text-xs" style={faint}>
            {STYLE_SAMPLE_HELPER}
            {note ? ` ${note}` : ""}
          </p>
        ))}
      {error && (
        <p
          className="mt-1 max-w-none text-xs"
          role="alert"
          style={{ color: "var(--xl-warn)" }}
        >
          {error}
        </p>
      )}
    </div>
  );
}
