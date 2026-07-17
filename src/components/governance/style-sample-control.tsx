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

import { useRef, useState } from "react";
import {
  STYLE_SAMPLE_ACCEPT,
  STYLE_SAMPLE_HELPER,
  styleSampleFileError,
} from "@/lib/governance/config";
import { apiUpload, api, WorkingRow } from "./shared";

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
}) {
  const [name, setName] = useState<string | null>(initialName);
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

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
      onChanged?.();
      // The host composes the one announcement (attached + what happens
      // next); announcing here too would overwrite it in the live region.
      if (onUploaded) onUploaded(r.data.styleSample.name);
      else onAnnounce?.(`Format sample attached: ${r.data.styleSample.name}.`);
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
      {name && reformat?.available && !reformat.queued && !removeOnly && (
        <div className="mt-2 flex flex-wrap items-baseline gap-x-6 gap-y-1">
          {reformat.busy ? (
            <>
              {reformat.passNote && (
                <span className="text-xs" style={faint}>
                  {reformat.passNote}
                </span>
              )}
              <button
                type="button"
                className="btn btn--text"
                disabled={reformat.stopping}
                aria-busy={reformat.stopping || undefined}
                onClick={reformat.onStop}
              >
                {reformat.stopping ? "Stopping..." : "Stop reformatting"}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn--text btn--stable"
              disabled={reformat.locked}
              onClick={reformat.onStart}
            >
              Reformat the whole draft
            </button>
          )}
        </div>
      )}
      {reformat?.busy && <WorkingRow long={reformat.long} kind="restyle" />}
      {!removeOnly && (
        <p className="mt-1 max-w-none text-xs" style={faint}>
          {STYLE_SAMPLE_HELPER}
          {note ? ` ${note}` : ""}
        </p>
      )}
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
