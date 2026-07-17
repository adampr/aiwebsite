"use client";

// Format-sample control (§5.12): shows whether a format sample is attached
// and lets the user add, replace, or remove one. Self-contained fetches; the
// host passes an optional onAnnounce wired to the workspace's single polite
// live region for success feedback, and onChanged so the host can refetch
// the project view (keeping other instances in sync). Errors render as
// role="alert" text, the one assertive exception (an upload failing silently
// reads as success). `disabled` locks add/replace only, and `removeOnly`
// hides them entirely (final projects): removing user data always works.

import { useRef, useState } from "react";
import {
  STYLE_SAMPLE_ACCEPT,
  STYLE_SAMPLE_HELPER,
  styleSampleFileError,
} from "@/lib/governance/config";
import { apiUpload, api, BusyLabel, WorkingRow } from "./shared";

const faint = { color: "var(--xl-text-faint)" } as const;
const dim = { color: "var(--xl-text-dim)" } as const;

/** Reformat-the-draft wiring (§5.12 restyle run), owned by the workspace:
 *  available = a sample is attached, the project is drafting or in review,
 *  and at least one section is drafted. */
export interface ReformatControl {
  available: boolean;
  busy: boolean;
  long: boolean;
  locked: boolean; // any turn in flight, feature disabled, or brain down
  passNote: string; // "" or "Pass 2 of 4." while a multi-pass run advances
  onStart: () => void;
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
}: {
  projectId: string;
  initialName: string | null;
  disabled: boolean;
  removeOnly?: boolean;
  note?: string;
  reformat?: ReformatControl;
  onAnnounce?: (text: string) => void;
  onChanged?: () => void;
}) {
  const [name, setName] = useState<string | null>(initialName);
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null);
  const [error, setError] = useState("");
  // Post-upload one-time offer to reformat what is already drafted (the
  // acknowledgment-with-agency the mid-project upload was missing).
  const [offer, setOffer] = useState(false);
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
      onAnnounce?.(`Format sample attached: ${r.data.styleSample.name}.`);
      onChanged?.();
      if (reformat?.available) setOffer(true);
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
      onAnnounce?.("Format sample removed.");
      onChanged?.();
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
      {offer && reformat?.available && !reformat.busy && (
        <div
          className="mt-3 border p-4"
          style={{ borderColor: "var(--xl-line-bright)" }}
        >
          <p className="max-w-none text-sm">
            Attached. Sections I draft from now on follow this sample. The
            sections already drafted keep their old look. Want me to reformat
            them now? It takes a few minutes and pauses other changes while
            it runs.
          </p>
          <p className="mt-2 max-w-none text-xs" style={faint}>
            Formatting only: headings, lists, tables, definitions. Your
            words, facts, and open items stay as they are.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-6">
            <button
              type="button"
              className="btn"
              disabled={reformat.locked}
              onClick={() => {
                setOffer(false);
                reformat.onStart();
              }}
            >
              Reformat the draft
            </button>
            <button
              type="button"
              className="btn btn--text"
              onClick={() => setOffer(false)}
            >
              Not now
            </button>
          </div>
        </div>
      )}
      {name && reformat?.available && !offer && !removeOnly && (
        <div className="mt-2">
          <button
            type="button"
            className="btn btn--text btn--stable"
            aria-busy={reformat.busy || undefined}
            disabled={reformat.locked || reformat.busy}
            onClick={reformat.onStart}
          >
            <BusyLabel
              busy={reformat.busy}
              idle="Reformat the whole draft"
              busyText="Reformatting"
            />
          </button>
          {reformat.busy && reformat.passNote && (
            <span className="ml-3 text-xs" style={faint}>
              {reformat.passNote}
            </span>
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
