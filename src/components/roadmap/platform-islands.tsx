"use client";

// Client islands for phases 09/10/11 (§5.20): the two singleton forms
// (API proxy, lakehouse), the Developer VMs environment picker, and the
// Builder Tools list with its pager.
//
// Every mutation POSTs and then calls router.refresh(), so the SERVER
// re-derives the step state and the runway above relights. The islands
// hold the freshly returned row only to render the verification result
// immediately (the check runs inside the POST, so the answer is already in
// the response and re-fetching would just show it a second later).
//
// role="alert" on error paragraphs and role="status" on success is the
// house convention, not decoration: the codebase has ~20 alert paragraphs
// and a round was spent fixing islands that announced success and stayed
// silent on failure.

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { usePagedList, PagerStrip } from "@/components/list-pager";
import { resetRoadmapNavProbe } from "@/components/roadmap-probe";
import { ROADMAP_CAPS, VM_ENVIRONMENTS } from "@/lib/roadmap/config";
import {
  CHECK_SCOPE_NOTE,
  NOT_COUNTED_NOTE,
  UNCHECKED_LINE,
  confirmedLine,
  failureLine,
} from "@/lib/roadmap/platform-copy";
import type { PublicLinkRow } from "@/lib/roadmap/platform-check";

type ApiError = { error?: { code?: string; message?: string } };

async function readError(res: Response): Promise<string> {
  const data = (await res.json().catch(() => null)) as ApiError | null;
  return data?.error?.message ?? "Something went wrong. Try again shortly.";
}

const faint = { color: "var(--xl-text-faint)" } as const;

function inputStyle() {
  return { borderColor: "var(--xl-line)" } as const;
}

/** One field's verification state, plus its Retry lever. The three states
 * are deliberately distinct in WORDS as well as colour: "confirmed",
 * "saved but not counting", and the failure reason. */
function FieldState({
  row,
  field,
  fieldLabel,
  isAdmin,
  onRetry,
  busy,
}: {
  row: PublicLinkRow | null;
  field: "url" | "docs";
  /** Human name of the field, for the Retry button's accessible name. */
  fieldLabel: string;
  isAdmin: boolean;
  onRetry: (field: "url" | "docs") => void;
  busy: boolean;
}) {
  if (!row) return null;
  const value = field === "url" ? row.url : row.docsUrl;
  if (!value) return null;
  const state = field === "url" ? row.urlState : row.docsState;
  const reason = field === "url" ? row.urlReason : row.docsReason;
  const status = field === "url" ? row.urlHttpStatus : row.docsHttpStatus;

  const line =
    state === "ok"
      ? confirmedLine(status)
      : state === "failed"
        ? failureLine(reason, status)
        : UNCHECKED_LINE;

  return (
    <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <p
        className="text-xs"
        style={faint}
        // A failed check is the thing the user must act on, so it is
        // announced; a pass is a status update.
        role={state === "failed" ? "alert" : "status"}
      >
        <span className="mono uppercase tracking-[0.2em]">
          {state === "ok" ? "Confirmed" : state === "failed" ? "Not counting" : "Not checked"}
        </span>{" "}
        · {line}
      </p>
      {isAdmin && state !== "ok" && (
        <button
          type="button"
          className="btn btn--text"
          // aria-disabled, NEVER the disabled attribute: this is the control
          // the user just pressed, and disabling a focused element moves
          // focus to <body> for the whole 12s the check can take. Same rule
          // the pager arrows follow.
          aria-disabled={busy}
          aria-busy={busy}
          // Four buttons per page would otherwise all be named "Retry".
          aria-label={`Retry the check for ${fieldLabel}`}
          onClick={() => {
            if (busy) return;
            onRetry(field);
          }}
        >
          {busy ? "Checking..." : "Retry"}
        </button>
      )}
    </div>
  );
}

/**
 * The API proxy and lakehouse forms: a URL plus an instructions URL.
 * `showUrl` is false for Developer VMs, which has no endpoint of its own.
 */
export function SingletonForm({
  kind,
  initial,
  isAdmin,
  urlLabel,
  urlHint,
  docsLabel,
  withEnvironments = false,
}: {
  kind: "api_proxy" | "dev_vms" | "lakehouse";
  initial: PublicLinkRow | null;
  isAdmin: boolean;
  urlLabel?: string;
  urlHint?: string;
  docsLabel: string;
  withEnvironments?: boolean;
}) {
  const router = useRouter();
  const [row, setRow] = useState<PublicLinkRow | null>(initial);
  const [url, setUrl] = useState(initial?.url ?? "");
  const [docsUrl, setDocsUrl] = useState(initial?.docsUrl ?? "");
  const [envs, setEnvs] = useState<string[]>(initial?.environments ?? []);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const known = VM_ENVIRONMENTS as readonly string[];
  const extras = envs.filter((e) => !known.includes(e));

  // Derived from the SAVED row (not the form fields), because it explains
  // why the step does not count, and the step counts on what is stored and
  // confirmed rather than on what is currently typed.
  const urlOk = row?.urlState === "ok";
  const docsOk = row?.docsState === "ok";
  const needs: string[] = [];
  if (withEnvironments) {
    if (!(row?.environments ?? []).length)
      needs.push("at least one hosting environment");
  } else if (!urlOk) {
    needs.push(row?.url ? "a confirmed address" : "an address");
  }
  if (!docsOk)
    needs.push(row?.docsUrl ? "confirmed instructions" : "an instructions link");
  const gap =
    needs.length === 0
      ? null
      : needs.length === 1
        ? needs[0]
        : `${needs.slice(0, -1).join(", ")} and ${needs[needs.length - 1]}`;

  function toggleEnv(value: string, on: boolean) {
    setEnvs((prev) =>
      on ? [...new Set([...prev, value])] : prev.filter((e) => e !== value)
    );
  }

  function addCustom() {
    const value = custom.trim();
    if (!value) return;
    if (envs.length >= ROADMAP_CAPS.environmentsMax) {
      setError(`Up to ${ROADMAP_CAPS.environmentsMax} environments.`);
      return;
    }
    if (envs.some((e) => e.toLowerCase() === value.toLowerCase())) {
      setCustom("");
      return;
    }
    setEnvs((prev) => [...prev, value]);
    setCustom("");
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/roadmap/platform", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind,
          url: withEnvironments ? null : url,
          docsUrl,
          environments: withEnvironments ? envs : undefined,
        }),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      const data = (await res.json()) as {
        row: PublicLinkRow;
        checkSkipped?: boolean;
      };
      setRow(data.row);
      setNotice(
        data.checkSkipped
          ? "Saved. We have run a lot of checks recently, so this one is queued for you to retry shortly."
          : "Saved."
      );
      resetRoadmapNavProbe();
      router.refresh();
    } catch {
      setError("That did not save. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function retry(field: "url" | "docs") {
    if (!row) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/roadmap/platform/recheck", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: row.id, field }),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      const data = (await res.json()) as { row: PublicLinkRow };
      setRow(data.row);
      resetRoadmapNavProbe();
      router.refresh();
    } catch {
      setError("The check did not complete. Try again shortly.");
    } finally {
      setBusy(false);
    }
  }

  if (!isAdmin) {
    return (
      <div className="mt-4 space-y-3 text-sm">
        {withEnvironments ? (
          <p>
            {envs.length
              ? `Hosting: ${envs.join(", ")}`
              : "No hosting environments listed yet."}
          </p>
        ) : (
          <p>
            {row?.url ? (
              <a href={row.url} rel="noopener noreferrer nofollow">
                {row.url}
              </a>
            ) : (
              "Nothing listed yet."
            )}
          </p>
        )}
        {row?.docsUrl && (
          <p>
            <a href={row.docsUrl} rel="noopener noreferrer nofollow">
              Instructions
            </a>
          </p>
        )}
        {/* Members see the SAME verification state admins do, minus the
            levers. Without this a member reads a plain link and has no way
            to know why the step is not counting, while the admin one desk
            over sees "Not counting" on the same row. */}
        <FieldState
          row={row}
          field="url"
          fieldLabel={urlLabel ?? "the address"}
          isAdmin={false}
          onRetry={() => {}}
          busy={false}
        />
        <FieldState
          row={row}
          field="docs"
          fieldLabel={docsLabel}
          isAdmin={false}
          onRetry={() => {}}
          busy={false}
        />
        <p className="text-xs" style={faint}>
          Your company admin keeps this up to date.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={save} className="mt-4 space-y-4">
      {withEnvironments ? (
        <fieldset className="space-y-2">
          <legend className="mono text-xs uppercase tracking-[0.2em]" style={faint}>
            Hosting environments
          </legend>
          {/* A checkbox group, not a multi-select listbox: multi-selects
              are famously hard to operate (ctrl-click to add, and a stray
              click wipes the whole selection), and the set here is short
              enough to show in full. */}
          <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {VM_ENVIRONMENTS.map((name) => (
              <label key={name} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={envs.includes(name)}
                  onChange={(e) => toggleEnv(name, e.target.checked)}
                />
                {name}
              </label>
            ))}
          </div>
          {extras.length > 0 && (
            <ul className="mt-2 space-y-1">
              {extras.map((name) => (
                <li key={name} className="flex items-center gap-3 text-sm">
                  <span>{name}</span>
                  <button
                    type="button"
                    className="btn btn--text"
                    onClick={() => toggleEnv(name, false)}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <input
              className="rounded-lg border bg-transparent px-3 py-2 text-sm"
              style={inputStyle()}
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              maxLength={ROADMAP_CAPS.environmentLabelMaxChars}
              placeholder="Something else"
              aria-label="Add another hosting environment"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addCustom();
                }
              }}
            />
            <button type="button" className="btn btn--text" onClick={addCustom}>
              Add
            </button>
          </div>
        </fieldset>
      ) : (
        <div>
          <label
            htmlFor={`${kind}-url`}
            className="mono text-xs uppercase tracking-[0.2em]"
            style={faint}
          >
            {urlLabel}
          </label>
          <input
            id={`${kind}-url`}
            className="mt-2 w-full rounded-lg border bg-transparent px-3 py-2 text-sm"
            style={inputStyle()}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            maxLength={500}
            inputMode="url"
            placeholder="https://proxy.example.com:8443"
          />
          {urlHint && (
            <p className="mt-1 text-xs" style={faint}>
              {urlHint}
            </p>
          )}
          <FieldState
            row={row}
            field="url"
            fieldLabel={urlLabel ?? "the address"}
            isAdmin={isAdmin}
            onRetry={retry}
            busy={busy}
          />
        </div>
      )}

      <div>
        <label
          htmlFor={`${kind}-docs`}
          className="mono text-xs uppercase tracking-[0.2em]"
          style={faint}
        >
          {docsLabel}
        </label>
        <input
          id={`${kind}-docs`}
          className="mt-2 w-full rounded-lg border bg-transparent px-3 py-2 text-sm"
          style={inputStyle()}
          value={docsUrl}
          onChange={(e) => setDocsUrl(e.target.value)}
          maxLength={500}
          inputMode="url"
          placeholder="https://wiki.example.com/how-to-connect"
        />
        <FieldState
          row={row}
          field="docs"
          fieldLabel={docsLabel}
          isAdmin={isAdmin}
          onRetry={retry}
          busy={busy}
        />
      </div>

      {/* WHY THIS COMPONENT IS NOT COUNTING, in words. Without it the most
          common near-miss is silent: an admin fills in the address, saves,
          sees "Confirmed" on that one line, and cannot tell why the step
          did not move. Both fields have to be confirmed, and for Developer
          VMs the environments list stands in for the address. */}
      {gap && (
        <p className="text-xs" style={faint}>
          Not counting yet: {gap}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-4">
        <button type="submit" className="btn" disabled={busy} aria-busy={busy}>
          {busy ? "Checking..." : "Save and check"}
        </button>
        {notice && (
          <p className="text-xs" style={faint} role="status">
            {notice}
          </p>
        )}
      </div>
      {error && (
        <p className="text-xs" role="alert" style={{ color: "var(--xl-warn)" }}>
          {error}
        </p>
      )}
      <p className="text-xs" style={faint}>
        {CHECK_SCOPE_NOTE} {NOT_COUNTED_NOTE}
      </p>
    </form>
  );
}

/** Step 11: the tool cards, added and paged here. */
export function ToolsManager({
  initial,
  isAdmin,
  truncated,
}: {
  initial: PublicLinkRow[];
  isAdmin: boolean;
  truncated: boolean;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<PublicLinkRow[]>(initial);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({
    label: "",
    url: "",
    docsUrl: "",
    description: "",
  });

  const labelRef = useRef<HTMLInputElement>(null);

  const pager = usePagedList(rows, "tool");

  function reset() {
    setForm({ label: "", url: "", docsUrl: "", description: "" });
    setEditing(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(
        editing
          ? `/api/roadmap/platform/tools/${encodeURIComponent(editing)}`
          : "/api/roadmap/platform/tools",
        {
          method: editing ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(form),
        }
      );
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      const data = (await res.json()) as { row: PublicLinkRow };
      setRows((prev) =>
        editing
          ? prev.map((r) => (r.id === data.row.id ? data.row : r))
          : [...prev, data.row]
      );
      setNotice(editing ? "Updated." : "Added.");
      reset();
      resetRoadmapNavProbe();
      router.refresh();
    } catch {
      setError("That did not save. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(
        `/api/roadmap/platform/tools/${encodeURIComponent(id)}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      setRows((prev) => prev.filter((r) => r.id !== id));
      setNotice("Removed.");
      resetRoadmapNavProbe();
      router.refresh();
    } catch {
      setError("That did not delete. Try again shortly.");
    } finally {
      setBusy(false);
    }
  }

  async function retry(id: string, field: "url" | "docs") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/roadmap/platform/recheck", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, field }),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      const data = (await res.json()) as { row: PublicLinkRow };
      setRows((prev) => prev.map((r) => (r.id === data.row.id ? data.row : r)));
      resetRoadmapNavProbe();
      router.refresh();
    } catch {
      setError("The check did not complete. Try again shortly.");
    } finally {
      setBusy(false);
    }
  }

  function startEdit(row: PublicLinkRow) {
    setEditing(row.id);
    setForm({
      label: row.label ?? "",
      url: row.url ?? "",
      docsUrl: row.docsUrl ?? "",
      description: row.description ?? "",
    });
    // The form sits ABOVE the list, so on a long page "Edit" would otherwise
    // repopulate something off screen and leave focus on a button whose
    // meaning just changed. Move focus to the first field: it scrolls the
    // form into view for a mouse user and puts a keyboard user where the
    // editing actually happens.
    requestAnimationFrame(() => labelRef.current?.focus());
  }

  return (
    <div className="space-y-10">
      {isAdmin && (
        <form onSubmit={submit} className="panel space-y-4">
          <span className="sys-label">{editing ? "Edit tool" : "Add a tool"}</span>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="tool-label" className="mono text-xs uppercase tracking-[0.2em]" style={faint}>
                Name
              </label>
              <input
                id="tool-label"
                ref={labelRef}
                className="mt-2 w-full rounded-lg border bg-transparent px-3 py-2 text-sm"
                style={inputStyle()}
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
                maxLength={ROADMAP_CAPS.toolLabelMaxChars}
                placeholder="Claude Code"
              />
            </div>
            <div>
              <label htmlFor="tool-url" className="mono text-xs uppercase tracking-[0.2em]" style={faint}>
                Link
              </label>
              <input
                id="tool-url"
                className="mt-2 w-full rounded-lg border bg-transparent px-3 py-2 text-sm"
                style={inputStyle()}
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                maxLength={500}
                inputMode="url"
                placeholder="https://tool.example.com"
              />
            </div>
          </div>
          <div>
            <label htmlFor="tool-docs" className="mono text-xs uppercase tracking-[0.2em]" style={faint}>
              Instructions link
            </label>
            <input
              id="tool-docs"
              className="mt-2 w-full rounded-lg border bg-transparent px-3 py-2 text-sm"
              style={inputStyle()}
              value={form.docsUrl}
              onChange={(e) => setForm({ ...form, docsUrl: e.target.value })}
              maxLength={500}
              inputMode="url"
              placeholder="https://wiki.example.com/getting-started"
            />
          </div>
          <div>
            <label htmlFor="tool-desc" className="mono text-xs uppercase tracking-[0.2em]" style={faint}>
              What it is for
            </label>
            <textarea
              id="tool-desc"
              className="mt-2 w-full rounded-lg border bg-transparent px-3 py-2 text-sm"
              style={inputStyle()}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              maxLength={ROADMAP_CAPS.toolDescriptionMaxChars}
              rows={3}
              placeholder="One or two lines your builders will actually read."
            />
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <button type="submit" className="btn" disabled={busy} aria-busy={busy}>
              {busy ? "Checking..." : editing ? "Save and check" : "Add and check"}
            </button>
            {editing && (
              <button type="button" className="btn btn--text" onClick={reset}>
                Cancel
              </button>
            )}
            {notice && (
              <p className="text-xs" style={faint} role="status">
                {notice}
              </p>
            )}
          </div>
          {error && (
            <p className="text-xs" role="alert" style={{ color: "var(--xl-warn)" }}>
              {error}
            </p>
          )}
          <p className="text-xs" style={faint}>
            {CHECK_SCOPE_NOTE} {NOT_COUNTED_NOTE}
          </p>
        </form>
      )}

      <div>
        {rows.length === 0 ? (
          <p className="text-sm" style={faint}>
            No tools listed yet. The step completes with the first tool whose
            link and instructions both check out.
          </p>
        ) : (
          <>
            {pager.showPager && (
              <PagerStrip pager={pager} idPrefix="tools" />
            )}
            <ul className="mt-6 grid gap-6 sm:grid-cols-2">
              {pager.windowed.map((row) => (
                <li key={row.id} className="panel">
                  <div className="flex items-baseline justify-between gap-4">
                    <h3 className="text-lg">{row.label}</h3>
                    <span className="mono text-xs" style={faint}>
                      {row.urlState === "ok" && row.docsState === "ok"
                        ? "Counting"
                        : "Not counting"}
                    </span>
                  </div>
                  {row.description && (
                    <p className="mt-3 text-sm">{row.description}</p>
                  )}
                  <p className="mt-3 text-sm">
                    {/* rel is load-bearing: these are addresses a company
                        admin typed, so they get no referrer, no window
                        handle, and no ranking signal from us. */}
                    <a href={row.url ?? "#"} rel="noopener noreferrer nofollow">
                      Open the tool
                    </a>
                    {row.docsUrl && (
                      <>
                        {" · "}
                        <a href={row.docsUrl} rel="noopener noreferrer nofollow">
                          Instructions
                        </a>
                      </>
                    )}
                  </p>
                  <FieldState
                    row={row}
                    field="url"
                    fieldLabel={`the ${row.label ?? "tool"} link`}
                    isAdmin={isAdmin}
                    onRetry={(f) => retry(row.id, f)}
                    busy={busy}
                  />
                  <FieldState
                    row={row}
                    field="docs"
                    fieldLabel={`the ${row.label ?? "tool"} instructions`}
                    isAdmin={isAdmin}
                    onRetry={(f) => retry(row.id, f)}
                    busy={busy}
                  />
                  <p className="mono mt-3 text-xs" style={faint}>
                    added by {row.addedByEmail}
                  </p>
                  {isAdmin && (
                    <div className="mt-3 flex flex-wrap items-center gap-4">
                      <button
                        type="button"
                        className="btn btn--text"
                        aria-disabled={busy}
                        aria-label={`Edit ${row.label ?? "this tool"}`}
                        onClick={() => {
                          // A save can be in flight for up to 12s; its
                          // success path calls reset(), which would clear
                          // the form this click just populated.
                          if (busy) return;
                          startEdit(row);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn btn--text"
                        aria-disabled={busy}
                        aria-busy={busy}
                        aria-label={`Remove ${row.label ?? "this tool"}`}
                        onClick={() => {
                          if (busy) return;
                          remove(row.id);
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            {pager.showPager && (
              <div className="mt-6">
                <PagerStrip pager={pager} idPrefix="tools" bottom />
              </div>
            )}
          </>
        )}
        {truncated && (
          <p className="mt-4 text-xs" style={faint}>
            Showing the first {ROADMAP_CAPS.toolsMax} tools.
          </p>
        )}
      </div>
    </div>
  );
}
