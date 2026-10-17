"use client";

// The supporting-documents library island (§5.17.23): the upload form and
// the list, with download and retire on each live row.
//
// Every write goes through the staff-gated library routes, which validate
// the file from its bytes (a PDF or a Word .docx, 32 MB at most), the title,
// the kind and the date; this form checks only what saves a doomed upload
// (no file, no title, an oversize file) and otherwise shows the route's own
// refusal word for word. Nothing here reads a file's content: the chosen
// File goes straight into the request body, and only its name (to suggest a
// title) and size are looked at.

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { When } from "@/components/when";
import {
  LIBRARY_KINDS,
  LIBRARY_MAX_BYTES,
  LIBRARY_MAX_COPY,
  LIBRARY_TITLE_MAX,
  extForMedia,
  titleFromFilename,
} from "@/lib/rfp/attachments";

export type LibraryRowView = {
  id: string;
  title: string;
  kind: string;
  media: string;
  confidential: boolean;
  redactedSample: boolean;
  /** "YYYY-MM-DD", a calendar date (no zone), or null. */
  asOf: string | null;
  sizeBytes: number;
  createdBy: string;
  /** ISO instants, formatted in the viewer's zone by <When />. */
  createdAt: string;
  retiredAt: string | null;
};

export const KIND_LABEL: Record<string, string> = {
  certification: "Certification",
  report: "Report",
  procedure: "Procedure",
  template: "Template",
  sample: "Sample",
  agreement: "Agreement",
};

/** "714 KB", "1.2 MB": decimal units, as the 32 MB cap is stated. */
export function sizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}

/** A calendar date as "Apr 30, 2025". Pinned to UTC because the value is a
 *  date with no zone: formatting it in the viewer's zone would move it a
 *  day for anyone west of Greenwich. */
export function asOfLabel(asOf: string | null): string {
  if (!asOf || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return "";
  const d = new Date(`${asOf}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

async function readError(res: Response | null, fallback: string): Promise<string> {
  if (!res) return "The server could not be reached.";
  const d = await res.json().catch(() => null);
  return typeof d?.message === "string" && d.message ? d.message : fallback;
}

export function LibraryManager({ rows }: { rows: LibraryRowView[] }) {
  return (
    <div className="space-y-10">
      <UploadForm />
      {rows.length === 0 ? (
        <div className="panel">
          <p className="text-faint">
            The library is empty. Add a document above and every proposal can
            attach it.
          </p>
        </div>
      ) : (
        <div className="panel">
          {rows.map((r, i) => (
            <div className={i > 0 ? "rfp-row" : undefined} key={r.id}>
              <LibraryRow row={r} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function UploadForm() {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<string>("certification");
  const [confidential, setConfidential] = useState(false);
  const [redactedSample, setRedactedSample] = useState(false);
  const [asOf, setAsOf] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [saved, setSaved] = useState("");

  const tooBig = file !== null && file.size > LIBRARY_MAX_BYTES;

  async function upload() {
    if (!file || busy) return;
    setBusy(true);
    setMsg("");
    setSaved("");
    const form = new FormData();
    form.append("file", file);
    form.append("title", title.trim());
    form.append("kind", kind);
    form.append("confidential", confidential ? "true" : "false");
    form.append("redactedSample", redactedSample ? "true" : "false");
    if (asOf) form.append("asOf", asOf);
    const res = await fetch("/api/rfp/library", {
      method: "POST",
      body: form,
    }).catch(() => null);
    setBusy(false);
    if (!res || !res.ok) {
      setMsg(
        res?.status === 413
          ? `That file is over the ${LIBRARY_MAX_COPY} limit.`
          : await readError(res, "That document was not added.")
      );
      return;
    }
    setSaved(`Added "${title.trim()}".`);
    setFile(null);
    setTitle("");
    setConfidential(false);
    setRedactedSample(false);
    setAsOf("");
    router.refresh();
  }

  return (
    <div className="panel panel--raised space-y-5">
      <span className="sys-label">Add a document</span>

      <div className="field">
        <span className="block text-sm">The file</span>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn btn--text"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            {file ? "Choose a different file" : "Choose a file"}
          </button>
          {file && (
            <span className="text-sm">
              {file.name}{" "}
              <span className="text-faint">· {sizeLabel(file.size)}</span>
            </span>
          )}
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          className="hidden"
          onChange={(e) => {
            const chosen = e.target.files?.[0] ?? null;
            setFile(chosen);
            setMsg("");
            setSaved("");
            if (chosen && !title.trim()) setTitle(titleFromFilename(chosen.name));
            // Reset so choosing the same file again re-fires change.
            e.target.value = "";
          }}
        />
        <p className="mt-2 text-xs text-faint">
          A PDF or a Word .docx, up to {LIBRARY_MAX_COPY}. The type is read
          from the file itself, not its name.
        </p>
        {tooBig && (
          <p className="mt-2 text-sm" role="alert">
            That file is {sizeLabel(file.size)}, over the {LIBRARY_MAX_COPY}{" "}
            limit.
          </p>
        )}
      </div>

      <div className="field">
        <label htmlFor="lib-title">Title</label>
        <input
          id="lib-title"
          className="input"
          value={title}
          maxLength={LIBRARY_TITLE_MAX}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="XL.net SOC 2 Type 2 Report (Nov 2024 - Apr 2025)"
        />
        <p className="mt-2 text-xs text-faint">
          Printed as written. The package names the file{" "}
          <span className="mono">Attachment N -</span>
          {" "}plus this title, and the Supporting Documents page lists it
          under the same title. No em dashes or curly braces.
        </p>
      </div>

      <div className="field">
        <label htmlFor="lib-kind">Kind</label>
        <select
          id="lib-kind"
          className="input"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          {LIBRARY_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k] ?? k}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="lib-asof">As of (optional)</label>
        <input
          id="lib-asof"
          type="date"
          className="input"
          value={asOf}
          onChange={(e) => setAsOf(e.target.value)}
        />
        <p className="mt-2 text-xs text-faint">
          The date the document speaks for, such as a report period&apos;s
          end or a certificate&apos;s issue date.
        </p>
      </div>

      <div className="space-y-3">
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={confidential}
            onChange={(e) => setConfidential(e.target.checked)}
          />
          <span>
            Confidential. A proposal attaches it only after someone confirms
            it for that client, and the Supporting Documents page says it is
            provided in confidence.
          </span>
        </label>
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={redactedSample}
            onChange={(e) => setRedactedSample(e.target.checked)}
          />
          <span>
            A sample from another engagement with that client&apos;s details
            removed. The Supporting Documents page says so.
          </span>
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy || !file || tooBig || title.trim().length < 2}
          onClick={() => void upload()}
        >
          {busy ? "Adding" : "Add to the library"}
        </button>
      </div>

      {msg && (
        <p className="text-sm" role="alert">
          {msg}
        </p>
      )}
      {saved && !msg && (
        <p className="text-sm" role="status">
          {saved}
        </p>
      )}
    </div>
  );
}

function LibraryRow({ row }: { row: LibraryRowView }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const retired = row.retiredAt !== null;
  const ext = extForMedia(row.media);

  async function retire() {
    setBusy(true);
    setError("");
    const res = await fetch(`/api/rfp/library/${row.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "retire" }),
    }).catch(() => null);
    setBusy(false);
    if (!res || !res.ok) {
      setError(await readError(res, "That document was not retired."));
      return;
    }
    setConfirming(false);
    router.refresh();
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="badge">{KIND_LABEL[row.kind] ?? row.kind}</span>
        {row.confidential && (
          <span className="badge badge--warn">Confidential</span>
        )}
        {row.redactedSample && <span className="badge">Redacted sample</span>}
        {retired && <span className="badge">Retired</span>}
        <span className="ml-auto text-xs text-faint">
          <When iso={row.createdAt} />
        </span>
      </div>
      <p className={`mt-2${retired ? " line-through text-faint" : ""}`}>
        {row.title}
      </p>
      <p className="mt-1 text-xs text-faint">
        {[
          ext ? ext.toUpperCase() : null,
          sizeLabel(row.sizeBytes),
          row.asOf ? `as of ${asOfLabel(row.asOf)}` : null,
          `added by ${row.createdBy}`,
        ]
          .filter(Boolean)
          .join(" · ")}
        {retired && row.retiredAt && (
          <>
            {" "}
            · retired <When iso={row.retiredAt} />
          </>
        )}
      </p>
      {retired && (
        <p className="mt-1 text-xs text-faint">
          No longer offered to new proposals. A proposal that already attached
          it still exports it.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <a
          className="btn btn--text"
          href={`/api/rfp/library/${row.id}`}
        >
          Download
        </a>
        {!retired && !confirming && (
          <button
            type="button"
            className="btn btn--text"
            disabled={busy}
            onClick={() => {
              setError("");
              setConfirming(true);
            }}
          >
            Retire
          </button>
        )}
      </div>

      {confirming && !retired && (
        <div
          className="mt-3 border p-4 text-sm"
          style={{ borderColor: "var(--xl-line-bright)" }}
          role="alertdialog"
          aria-label={`Retire ${row.title}`}
        >
          <p>
            Retire this document? New proposals will no longer be offered it.
            Proposals that already attached it keep it, and it stays listed
            here, struck through. This cannot be undone from this page.
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy}
              onClick={() => void retire()}
            >
              {busy ? "Retiring" : "Retire it"}
            </button>
            <button
              type="button"
              className="btn btn--text"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Keep it
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="mt-2 text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
