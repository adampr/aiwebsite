"use client";

// The one submission form (§5.16), shared by the /work dialog and the
// /work/submit page so validation and microcopy cannot fork. The client
// never gates anything: every check here is a convenience copy of a
// server-enforced rule.
//
// context="page": success shows a notice above the form, fields reset, and
// onSubmitted fires (the page refreshes its status list).
// context="dialog": success REPLACES the form in place (the dialog stays
// open so the handoff link is read); state is never reset on dialog close,
// so a typed draft survives an accidental Esc.

import Link from "next/link";
import { useId, useRef, useState } from "react";

// No Retry direction here: this string also serves the roadmap dialog,
// whose tracking page renders Retry only for some rows; the automatic queue
// drain (§5.16) is the primary path and the status lists carry the lever.
const QUEUED_NOTICE =
  "Received. Your submission is queued and the review starts automatically when the panel has capacity. Once it runs, you will get an email when the card publishes or is held.";
const OK_NOTICE =
  "Received. The panel is reviewing; you will get an email either way.";
const OK_NOTICE_UPDATE =
  "Received. The panel is reviewing your update; if it passes, it waits for Adam's approval before the live card changes.";

interface SubmissionFormProps {
  context: "page" | "dialog";
  onSubmitted?: () => void;
  onBusyChange?: (busy: boolean) => void;
  onClose?: () => void; // dialog only
  /** §5.16 update mode: the published card being updated. Title and kind
   * are pinned server-side; the form shows them locked and never sends
   * either field (the update route 400s on a typed value). */
  updateTarget?: {
    id: string;
    title: string;
    kind: "skill" | "program";
  } | null;
  /** §5.18 company reuse: where "track it" points. Defaults keep every /work
   * usage byte-identical; /roadmap/work passes its own values. */
  trackHref?: string;
  /** Credit fallback named in the attribution placeholder. */
  creditTeamName?: string;
  /** The retention fine print (the staff default names Adam; company copy
   * must not). */
  retentionLine?: string;
}

export function SubmissionForm({
  context,
  onSubmitted,
  onBusyChange,
  onClose,
  updateTarget = null,
  trackHref = "/work/submit",
  creditTeamName = "the XL.net team",
  retentionLine = "Uploads with credential files are rejected. Only document text is kept for review; the original files are emailed to Adam when the card publishes.",
}: SubmissionFormProps) {
  const [kindState, setKind] = useState<"skill" | "program">("skill");
  const kind = updateTarget ? updateTarget.kind : kindState;
  const [title, setTitle] = useState("");
  const [blurb, setBlurb] = useState("");
  const [attribution, setAttribution] = useState("");
  const [pkg, setPkg] = useState<File | null>(null);
  const [skillMd, setSkillMd] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [serverPaths, setServerPaths] = useState<string[]>([]);
  const [done, setDone] = useState<null | { queued: boolean }>(null);
  const pkgRef = useRef<HTMLInputElement>(null);
  const mdRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const uid = useId();

  // A landed file clears that field's error immediately (a red border with
  // a green check until the next submit is a contradiction; design-critic
  // ruling 2026-07-30).
  const takePkg = (f: File | null) => {
    setPkg(f);
    if (f)
      setFieldErrors((prev) => {
        const next = { ...prev };
        delete next.pkg;
        return next;
      });
  };
  const takeMd = (f: File | null) => setSkillMd(f);

  const setBusyBoth = (b: boolean) => {
    setBusy(b);
    onBusyChange?.(b);
  };

  function resetForm() {
    setTitle("");
    setBlurb("");
    setAttribution("");
    setPkg(null);
    setSkillMd(null);
    setFieldErrors({});
    setServerError(null);
    setServerPaths([]);
    if (pkgRef.current) pkgRef.current.value = "";
    if (mdRef.current) mdRef.current.value = "";
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setServerError(null);
    setServerPaths([]);
    const errs: Record<string, string> = {};
    if (!pkg)
      errs.pkg =
        kind === "program"
          ? "Attach the .zip of your program."
          : "Attach the Skill package (.skill or .zip).";
    // The SKILL.md field is optional (the package may carry the doc); only
    // the server can see inside the archive, so no client check exists.
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) {
      pkgRef.current?.focus();
      return;
    }
    setBusyBoth(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const timeout = setTimeout(() => ctrl.abort(), 90_000);
    try {
      const form = new FormData();
      if (!updateTarget) {
        form.set("kind", kind);
        form.set("title", title);
      }
      form.set("blurb", blurb);
      form.set("attribution", attribution);
      form.set("file", pkg as File);
      if (kind === "skill" && skillMd) form.set("skillMd", skillMd);
      const res = await fetch(
        updateTarget
          ? `/api/work/submissions/${updateTarget.id}/update`
          : "/api/work/submissions",
        {
          method: "POST",
          body: form,
          signal: ctrl.signal,
        }
      );
      const data = (await res.json().catch(() => null)) as {
        error?: { code?: string; message?: string; paths?: string[] };
        queued?: string | null;
      } | null;
      if (!res.ok) {
        // Server 422s carry instructional copy; render it verbatim.
        setServerError(
          data?.error?.message ?? "Something went wrong. Try again shortly."
        );
        setServerPaths(data?.error?.paths ?? []);
        return;
      }
      setDone({ queued: Boolean(data?.queued) });
      if (context === "page") resetForm();
      onSubmitted?.();
    } catch {
      setServerError(
        "The upload did not complete. Check your connection and try again; your entries are still here."
      );
    } finally {
      clearTimeout(timeout);
      abortRef.current = null;
      setBusyBoth(false);
    }
  }

  const inputCls = "w-full rounded-lg border bg-transparent px-3 py-2 text-sm";
  const inputStyle = { borderColor: "var(--xl-line)" } as const;
  const labelCls = "mono text-xs uppercase tracking-[0.2em] text-light";

  // Dialog success state replaces the form; the notice carries the handoff.
  if (done && context === "dialog") {
    return (
      <div className="space-y-5">
        <p className="text-sm" role="status" tabIndex={-1} ref={(el) => el?.focus()}>
          {done.queued ? QUEUED_NOTICE : OK_NOTICE}
        </p>
        <div className="flex flex-wrap gap-4">
          <Link href={trackHref} className="btn no-underline">
            Track it on your submissions page
          </Link>
          <button
            type="button"
            className="btn btn--text"
            onClick={() => {
              setDone(null);
              resetForm();
            }}
          >
            Submit another
          </button>
          {onClose && (
            <button type="button" className="btn btn--text" onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      {done && context === "page" && (
        <p className="text-sm" role="status">
          {done.queued
            ? QUEUED_NOTICE
            : updateTarget
              ? OK_NOTICE_UPDATE
              : OK_NOTICE}
        </p>
      )}
      {updateTarget ? (
        <div className="space-y-2">
          <p className="text-sm">
            Updating the published card{" "}
            <span className="font-medium">{updateTarget.title}</span> (
            {updateTarget.kind === "skill" ? "CoWork Skill" : "Code program"}
            ).
          </p>
          <p className="text-xs text-faint">
            Updates keep the card&apos;s title and kind; renaming stays admin
            only. Attach the full new package, not a changelog. The live card
            stays up until Adam approves the reviewed update.
          </p>
        </div>
      ) : (
        <>
          <div className="flex gap-4">
            {(
              [
                ["skill", "CoWork Skill"],
                ["program", "Code program"],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="kind"
                  checked={kind === value}
                  onChange={() => setKind(value)}
                />
                {label}
              </label>
            ))}
          </div>
          <div>
            <label className={labelCls}>Title</label>
            <input
              className={inputCls}
              style={inputStyle}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              minLength={4}
              maxLength={60}
              required
              placeholder="What the tool is called"
            />
          </div>
        </>
      )}
      <div>
        <label className={labelCls}>One paragraph (optional)</label>
        <textarea
          className={inputCls}
          style={inputStyle}
          value={blurb}
          onChange={(e) => setBlurb(e.target.value)}
          maxLength={900}
          rows={4}
          placeholder="Optional context: what it does, who uses it, what it replaced (up to 900 characters). The card's claims come from your documents."
        />
      </div>
      <div>
        <span id={`${uid}-pkg-label`} className={labelCls}>
          {kind === "program"
            ? "Program .zip (must include architecture.md or equivalent)"
            : "Skill package (.skill or .zip)"}
        </span>
        <label
          className={
            "file-drop mt-2" +
            (fieldErrors.pkg ? " file-drop--error" : "") +
            (pkg ? " file-drop--filled" : "")
          }
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            // The bordered zone invites drops; an unhandled drop would
            // navigate the browser away and destroy the draft.
            e.preventDefault();
            const files = e.dataTransfer.files;
            if (files?.length && pkgRef.current) {
              pkgRef.current.files = files;
              takePkg(files[0]);
            }
          }}
        >
          <input
            ref={pkgRef}
            type="file"
            accept={kind === "program" ? ".zip" : ".skill,.zip"}
            aria-labelledby={`${uid}-pkg-label`}
            aria-describedby={
              fieldErrors.pkg
                ? `${uid}-pkg-error ${uid}-pkg-help`
                : `${uid}-pkg-help`
            }
            aria-invalid={Boolean(fieldErrors.pkg)}
            onChange={(e) => takePkg(e.target.files?.[0] ?? null)}
          />
          <span className="file-drop-glyph" aria-hidden="true">
            {pkg ? "✓" : "+"}
          </span>
          {pkg ? (
            <>
              <span className="file-drop-name">{pkg.name}</span>
              <span className="file-drop-cta">Replace</span>
            </>
          ) : (
            <>
              <span className="file-drop-cta">Choose file</span>
              <span className="mono text-xs text-faint">
                {kind === "program" ? ".zip" : ".skill or .zip"}
              </span>
            </>
          )}
        </label>
        {fieldErrors.pkg && (
          <p id={`${uid}-pkg-error`} className="mt-1 text-xs text-red-400">
            {fieldErrors.pkg}
          </p>
        )}
        <p id={`${uid}-pkg-help`} className="mt-2 text-xs text-faint">
          {kind === "program"
            ? "The zip needs an architecture.md (or ARCHITECTURE.md, design.md, or a README.md with an Architecture section) at the top level or one folder deep: what it does, its components, how data flows. Max 10 MB."
            : "Two shapes work: a .skill or .zip with SKILL.md at the top level or one folder deep, or one .zip holding both the .skill and its .md file. If the .md is in the package, the second upload is optional. Max 10 MB."}
        </p>
      </div>
      {kind === "skill" && (
        <div>
          <span id={`${uid}-md-label`} className={labelCls}>
            SKILL.md (optional if it is already in your package)
          </span>
          <label
            className={"file-drop mt-2" + (skillMd ? " file-drop--filled" : "")}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const files = e.dataTransfer.files;
              if (files?.length && mdRef.current) {
                mdRef.current.files = files;
                takeMd(files[0]);
              }
            }}
          >
            <input
              ref={mdRef}
              type="file"
              accept=".md,.mdx,.markdown"
              aria-labelledby={`${uid}-md-label`}
              aria-describedby={`${uid}-md-help`}
              onChange={(e) => takeMd(e.target.files?.[0] ?? null)}
            />
            <span className="file-drop-glyph" aria-hidden="true">
              {skillMd ? "✓" : "+"}
            </span>
            {skillMd ? (
              <>
                <span className="file-drop-name">{skillMd.name}</span>
                <span className="file-drop-cta">Replace</span>
              </>
            ) : (
              <>
                <span className="file-drop-cta">Choose file</span>
                <span className="mono text-xs text-faint">.md (optional)</span>
              </>
            )}
          </label>
          <p id={`${uid}-md-help`} className="mt-2 text-xs text-faint">
            Skip this if your package already carries the SKILL.md. Attach it
            only when you want the panel to review this exact text; a file
            attached here wins over the copy inside the package. Max 1 MB.
          </p>
        </div>
      )}
      <p className="text-xs text-faint">{retentionLine}</p>
      <div>
        <label className={labelCls}>Public credit (optional)</label>
        <input
          className={inputCls}
          style={inputStyle}
          value={attribution}
          onChange={(e) => setAttribution(e.target.value)}
          maxLength={20}
          placeholder={`First name only. Empty publishes as ${creditTeamName}.`}
        />
      </div>
      {serverError && (
        <div role="alert" className="text-sm text-red-400">
          <p>{serverError}</p>
          {serverPaths.length > 0 && (
            <ul className="mono mt-1 text-xs">
              {serverPaths.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-4">
        <button type="submit" className="btn" disabled={busy}>
          {busy
            ? "Uploading..."
            : updateTarget
              ? "Submit update"
              : "Submit for review"}
        </button>
        {busy && (
          <button
            type="button"
            className="btn btn--text"
            onClick={() => abortRef.current?.abort()}
          >
            Cancel upload
          </button>
        )}
        {!busy && context === "dialog" && onClose && (
          <button type="button" className="btn btn--text" onClick={onClose}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
