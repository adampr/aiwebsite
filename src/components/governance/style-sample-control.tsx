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

import { useEffect, useId, useRef, useState } from "react";
import {
  STYLE_SAMPLE_ACCEPT,
  STYLE_SAMPLE_DEBT_NOTE,
  STYLE_SAMPLE_HELPER,
  STYLE_SAMPLE_RESYNC_HELPER,
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

/** Human display form of a stored letterhead line (round 17): tokens become
 *  bracketed placeholders, tabs become a middot separator. */
export function displayFrameLine(line: string): string {
  return line
    .split("{{PAGE}}")
    .join("[page number]")
    .split("{{PAGES}}")
    .join("[page count]")
    .split("{{TITLE}}")
    .join("[document title]")
    .split("\t")
    .join(" · ");
}

/** Part-accurate letterhead adoption copy (round 17): never claims both
 *  parts when only one stored text survives. Empty when neither did. */
export function letterheadPartCopy(letterhead: {
  header: string;
  footer: string;
}): string {
  const hasH = letterhead.header.trim().length > 0;
  const hasF = letterhead.footer.trim().length > 0;
  if (hasH && hasF) return "page header and footer";
  if (hasH) return "page header";
  if (hasF) return "page footer";
  return "";
}

/** One-time honesty line when the sample's register and the existing draft
 *  are two bands apart (round 17, panel must-have): reformatting matches
 *  look, never length, and without this line the owner's literal scenario
 *  (terse sample over a long draft) reads as "the feature did nothing".
 *  Returns "" when the gap is smaller or nothing is drafted. */
export function sampleLengthNote(
  documents: { slug: string; sections: { id: string; markdown: string }[] }[],
  placeholders: Record<string, string[]>,
  verbosity: { band: "concise" | "standard" | "expansive" } | null | undefined
): string {
  if (!verbosity || verbosity.band === "standard") return "";
  let words = 0;
  let sections = 0;
  for (const d of documents)
    for (const s of d.sections) {
      if ((placeholders[d.slug] ?? []).includes(s.id)) continue;
      sections++;
      words += s.markdown.split(/\s+/).filter(Boolean).length;
    }
  if (sections === 0) return "";
  const avg = words / sections;
  if (verbosity.band === "concise" && avg > 380)
    return "Your sample runs shorter than the current draft. Reformatting matches its look, not its length; to tighten a section, ask for that in a revision or your next answer.";
  if (verbosity.band === "expansive" && avg < 160)
    return "Your sample runs longer than the current draft. Reformatting matches its look, not its length; to expand a section, ask for that in a revision or your next answer.";
  return "";
}

/** Reformat-the-draft wiring (§5.12 restyle run), owned by the workspace:
 *  available = a sample is attached, the project is drafting or in review,
 *  and at least one section is drafted. One consent contract in every state:
 *  queued has Skip, running has Stop; both mean "no more restyling". */
export interface ReformatControl {
  available: boolean;
  // Server-stored reformat debt (round 16): the sample changed since the
  // last COMPLETE reformat run. The idle start button renders ONLY with
  // debt: after a clean auto-run it would be a no-op with a job-sounding
  // label. Every interrupted-run receipt that names the button fires on a
  // path where debt stands, so the button exists whenever copy names it.
  debt: boolean;
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
  letterhead,
  verbosity,
  lengthNote,
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
  // Round 17, from the VIEW like numbering. undefined = host does not
  // surface them. letterhead null = stored before capture existed (legacy);
  // empty strings = a .docx was scanned and nothing usable was found.
  letterhead?: { header: string; footer: string } | null;
  verbosity?: {
    band: "concise" | "standard" | "expansive";
    targetWords: number;
  } | null;
  // Pre-composed length-mismatch line (sampleLengthNote); "" hides it.
  lengthNote?: string;
}) {
  const [name, setName] = useState<string | null>(initialName);
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const runNoteId = useId();
  const debtNoteId = useId();
  // Focus continuity for the debt-gated idle block (round 16): when a poll
  // clears debt (run finished, maybe in another tab) while focus is inside
  // the block, the unmount would drop focus to body. Track focus-inside via
  // capture handlers; clearing on EVERY blur is what makes this sound: a
  // removed focused element fires NO blur, so the flag survives unmount
  // exactly when focus was inside at removal, while ordinary tab-away and
  // page clicks (blur with any relatedTarget) clear it.
  const focusInsideIdleRef = useRef(false);
  const sampleStatusRef = useRef<HTMLParagraphElement | null>(null);
  const stopBtnRef = useRef<HTMLButtonElement | null>(null);

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

  // Debt-gated idle start (round 16): the one state where pressing the
  // button does something. No debt = the happy path renders nothing here;
  // absence of a call to action is itself the "all done" signal.
  const idleReformatVisible =
    !!name &&
    !!reformat?.available &&
    reformat.debt &&
    !reformat.busy &&
    !reformat.queued &&
    !removeOnly;

  useEffect(() => {
    if (!idleReformatVisible && focusInsideIdleRef.current) {
      focusInsideIdleRef.current = false;
      if (document.activeElement === document.body) {
        // Start-click swaps the block for the busy row: land on its Stop
        // button (the control the user now needs). Any other unmount
        // (debt cleared by a landed run) parks on the sample status line.
        (stopBtnRef.current ?? sampleStatusRef.current)?.focus();
      }
    }
  }, [idleReformatVisible]);

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
          its own without the buttons interleaving mid-wrap. tabIndex -1: the
          debt block's focus-continuity effect parks focus here on unmount. */}
      <p className="max-w-none" style={dim} tabIndex={-1} ref={sampleStatusRef}>
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
      {/* Letterhead transparency (round 17): what will actually print. The
          preview shows the stored lines verbatim (tokens humanized) so a
          stale or wrong line is noticed BEFORE the first export, and every
          empty state says honestly why nothing carries over. */}
      {name &&
        letterhead !== undefined &&
        (() => {
          const lower = name.toLowerCase();
          if (letterhead === null) {
            if (lower.endsWith(".docx"))
              return (
                <p className="mt-1 max-w-none text-xs" style={dim}>
                  This sample was stored before letterhead capture existed.
                  Replace it (the same file is fine) to carry its page header
                  and footer text into your Word downloads.
                </p>
              );
            if (lower.endsWith(".pdf"))
              return (
                <p className="mt-1 max-w-none text-xs" style={dim}>
                  Page header and footer text cannot be carried over from a
                  PDF. Upload the .docx version to include it in downloads.
                </p>
              );
            return null;
          }
          const part = letterheadPartCopy(letterhead);
          if (!part)
            return lower.endsWith(".docx") ? (
              <p className="mt-1 max-w-none text-xs" style={dim}>
                No header or footer text was found in this sample. A logo-only
                letterhead cannot be carried over; downloads keep the standard
                layout.
              </p>
            ) : null;
          const group = (label: string, text: string) =>
            text.trim()
              ? text
                  .split("\n")
                  .filter(Boolean)
                  .map((l, i) => (
                    <p
                      key={`${label}-${i}`}
                      className="max-w-none"
                      style={faint}
                    >
                      {i === 0 ? `${label}: ` : ""}
                      <span className="mono break-words">
                        {displayFrameLine(l)}
                      </span>
                    </p>
                  ))
              : null;
          return (
            <div
              className="mt-1 text-xs"
              data-qa="style-sample-letterhead"
              style={dim}
            >
              <p className="max-w-none">
                Word downloads carry this sample&apos;s {part} (text only;
                logos and images cannot be carried over):
              </p>
              {group("Header", letterhead.header)}
              {group("Footer", letterhead.footer)}
            </div>
          );
        })()}
      {/* Verbosity transparency (round 17): fine print for the non-standard
          bands only (the middle band is the default register and a line
          about it would be noise). States intent, never an outcome. */}
      {name && verbosity != null && verbosity.band !== "standard" && (
        <p
          className="mt-1 max-w-none text-xs"
          data-qa="style-sample-verbosity"
          style={dim}
        >
          {verbosity.band === "concise"
            ? `The sample keeps its sections short, so I aim for about ${verbosity.targetWords} words per section when drafting new text.`
            : `The sample writes in detail, so I aim for about ${verbosity.targetWords} words per section when drafting new text.`}
        </p>
      )}
      {name && lengthNote ? (
        <p
          className="mt-1 max-w-none text-xs"
          data-qa="style-sample-length-note"
          style={dim}
        >
          {lengthNote}
        </p>
      ) : null}
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
            ref={stopBtnRef}
            className="btn btn--text"
            aria-busy={reformat.stopping || undefined}
            onClick={reformat.onStop}
          >
            {reformat.stopping ? "Stopping..." : "Stop reformatting"}
          </button>
        </div>
      )}
      {/* Debt-gated (round 16): renders ONLY while the server says the draft
          may predate the current sample (interrupted, stopped, or skipped
          run; reload; another tab). A clean auto-run clears the debt and
          this whole block with it. Same label as every receipt that names
          the button. */}
      {idleReformatVisible && reformat && (
        <div
          className="mt-2"
          onFocusCapture={() => {
            focusInsideIdleRef.current = true;
          }}
          onBlurCapture={() => {
            focusInsideIdleRef.current = false;
          }}
        >
          <p
            id={debtNoteId}
            data-qa="style-sample-debt-note"
            className="max-w-none text-sm"
            style={dim}
          >
            {STYLE_SAMPLE_DEBT_NOTE}
          </p>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <button
              type="button"
              className="btn btn--text btn--stable"
              disabled={reformat.locked}
              aria-describedby={debtNoteId}
              onClick={reformat.onStart}
            >
              Reformat the whole draft
            </button>
          </div>
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
            {/* Drift re-sync line (round 16): workspace instances only (a
                reformat control exists = something can drift), and not while
                the debt block already offers the stronger path right above. */}
            {reformat && !idleReformatVisible
              ? ` ${STYLE_SAMPLE_RESYNC_HELPER}`
              : ""}
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
