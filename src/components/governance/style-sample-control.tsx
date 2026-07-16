"use client";

// Format-sample control (§5.12): shows whether a sample policy is attached
// and lets the user add, replace, or remove one. Self-contained (owns its
// fetches and status line) so host screens embed it with two props. Status
// changes are visual text only; the workspace live region is not involved.

import { useRef, useState } from "react";
import {
  STYLE_SAMPLE_ACCEPT,
  styleSampleFileError,
} from "@/lib/governance/config";
import { apiUpload, api } from "./shared";

const faint = { color: "var(--xl-text-faint)" } as const;
const dim = { color: "var(--xl-text-dim)" } as const;

export function StyleSampleControl({
  projectId,
  initialName,
  disabled,
}: {
  projectId: string;
  initialName: string | null;
  disabled: boolean;
}) {
  const [name, setName] = useState<string | null>(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  async function upload(file: File) {
    const precheck = styleSampleFileError(file.name, file.size);
    if (precheck) {
      setError(precheck);
      return;
    }
    setBusy(true);
    setError("");
    const form = new FormData();
    form.append("file", file);
    const r = await apiUpload<{ styleSample: { name: string } }>(
      `/api/governance/projects/${encodeURIComponent(projectId)}/style-sample`,
      form
    );
    setBusy(false);
    if (r.ok) setName(r.data.styleSample.name);
    else setError(r.message);
  }

  async function remove() {
    setBusy(true);
    setError("");
    const r = await api<undefined>(
      `/api/governance/projects/${encodeURIComponent(projectId)}/style-sample`,
      { method: "DELETE" }
    );
    setBusy(false);
    if (r.ok || r.status === 404) setName(null);
    else setError(r.message);
  }

  return (
    <div className="mt-4 text-sm">
      <input
        ref={inputRef}
        type="file"
        accept={STYLE_SAMPLE_ACCEPT}
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void upload(f);
        }}
      />
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span style={dim}>
          {name ? (
            <>
              Format sample: <span className="mono">{name}</span>
            </>
          ) : (
            "No format sample attached."
          )}
        </span>
        <button
          type="button"
          className="btn btn--text"
          disabled={busy || disabled}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? "Working..." : name ? "Replace" : "Add a sample policy"}
        </button>
        {name && (
          <button
            type="button"
            className="btn btn--text"
            disabled={busy || disabled}
            onClick={() => void remove()}
          >
            Remove
          </button>
        )}
      </div>
      <p className="mt-1 max-w-none text-xs" style={faint}>
        Optional. Upload a current company policy (.docx, .md, or .txt) and
        the draft will follow its heading, list, and numbering style. Its
        content is never copied.
      </p>
      {error && (
        <p className="mt-1 max-w-none text-xs" role="alert" style={{ color: "var(--xl-warn)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
