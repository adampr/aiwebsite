"use client";

// Submission form + "my submissions" list with a status poll (§5.16).
// The client never gates anything: every check here is a convenience copy
// of a server-enforced rule.

import { useCallback, useEffect, useRef, useState } from "react";

interface StatusRow {
  id: string;
  title: string;
  kind: string;
  status: string;
  stage: string | null;
  error: string | null;
  slug: string | null;
  stale: boolean;
  createdAt: string;
}

const STATUS_COPY: Record<string, string> = {
  received: "Queued for review",
  running: "Panel reviewing",
  published: "Published",
  held: "Held for a human look",
  failed: "Review failed",
};

export function SubmitClient() {
  const [kind, setKind] = useState<"skill" | "program">("skill");
  const [title, setTitle] = useState("");
  const [blurb, setBlurb] = useState("");
  const [attribution, setAttribution] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rows, setRows] = useState<StatusRow[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/work/submissions", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { submissions: StatusRow[] };
      setRows(data.submissions);
    } catch {
      // poll failures are silent; the next tick retries
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(t);
  }, [refresh]);
  const anyActive = rows.some(
    (r) => r.status === "received" || r.status === "running"
  );
  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(t);
  }, [anyActive, refresh]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!file) {
      setError(
        kind === "program"
          ? "Attach the .zip of your program."
          : "Attach the skill package (.skill or .zip) or its .md file."
      );
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.set("kind", kind);
      form.set("title", title);
      form.set("blurb", blurb);
      form.set("attribution", attribution);
      form.set("file", file);
      const res = await fetch("/api/work/submissions", {
        method: "POST",
        body: form,
      });
      const data = (await res.json().catch(() => null)) as {
        error?: { message?: string };
        queued?: string | null;
      } | null;
      if (!res.ok) {
        setError(
          data?.error?.message ?? "Something went wrong. Try again shortly."
        );
        return;
      }
      setNotice(
        data?.queued
          ? "Received. The panel is briefly unavailable; use Retry on the row below in a few minutes."
          : "Received. The panel is reviewing; you will get an email either way."
      );
      setTitle("");
      setBlurb("");
      setAttribution("");
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      void refresh();
    } finally {
      setBusy(false);
    }
  }

  async function retry(id: string) {
    const res = await fetch(`/api/work/submissions/${id}/retry`, {
      method: "POST",
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setError(data?.error?.message ?? "Retry failed.");
    }
    void refresh();
  }

  async function withdraw(id: string) {
    if (!confirm("Withdraw this submission? This deletes it entirely.")) return;
    await fetch(`/api/work/submissions/${id}`, { method: "DELETE" });
    void refresh();
  }

  const inputCls =
    "w-full rounded-lg border bg-transparent px-3 py-2 text-sm";
  const inputStyle = { borderColor: "var(--xl-line)" } as const;

  return (
    <div className="space-y-8">
      <form onSubmit={submit} className="panel panel--raised space-y-5">
        <div className="flex gap-4">
          {(
            [
              ["skill", "CoWork skill"],
              ["program", "Claude Code program"],
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
          <label className="mono text-xs uppercase tracking-[0.2em] text-light">
            Title
          </label>
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
        <div>
          <label className="mono text-xs uppercase tracking-[0.2em] text-light">
            One paragraph
          </label>
          <textarea
            className={inputCls}
            style={inputStyle}
            value={blurb}
            onChange={(e) => setBlurb(e.target.value)}
            minLength={80}
            maxLength={900}
            rows={4}
            required
            placeholder="What it does, who uses it, what it replaced (80 to 900 characters). Context only: the card's claims come from your documents."
          />
        </div>
        <div>
          <label className="mono text-xs uppercase tracking-[0.2em] text-light">
            {kind === "program"
              ? "Program .zip (must include architecture.md or equivalent)"
              : "Skill package (.skill / .zip) or its .md file"}
          </label>
          <input
            ref={fileRef}
            type="file"
            className="mt-2 block w-full text-sm"
            accept={kind === "program" ? ".zip" : ".skill,.zip,.md,.mdx,.markdown"}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <p className="mt-2 text-xs text-faint">
            {kind === "program"
              ? "The zip needs an architecture.md (or ARCHITECTURE.md, design.md, or a README.md with an Architecture section) at the top level or one folder deep: what it does, its components, how data flows. Uploads with credential files are rejected. Max 10 MB; only document text is kept."
              : "The package needs its SKILL.md at the top level. Uploads with credential files are rejected. Max 10 MB; only document text is kept."}
          </p>
        </div>
        <div>
          <label className="mono text-xs uppercase tracking-[0.2em] text-light">
            Public credit (optional)
          </label>
          <input
            className={inputCls}
            style={inputStyle}
            value={attribution}
            onChange={(e) => setAttribution(e.target.value)}
            maxLength={20}
            placeholder="First name only. Empty publishes as the XL.net team."
          />
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
        {notice && <p className="text-sm">{notice}</p>}
        <button type="submit" className="btn" disabled={busy}>
          {busy ? "Uploading..." : "Submit for review"}
        </button>
      </form>

      {rows.length > 0 && (
        <div className="panel space-y-4">
          <h2 className="mono text-xs uppercase tracking-[0.2em] text-light">
            Your submissions
          </h2>
          {rows.map((r) => (
            <div
              key={r.id}
              className="border-t border-[var(--xl-line)] pt-3 text-sm"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-medium">{r.title}</span>
                <span className="badge badge--light">
                  {STATUS_COPY[r.status] ?? r.status}
                </span>
                {r.stage && <span className="text-faint">{r.stage}</span>}
              </div>
              {r.status === "published" && r.slug && (
                <p className="mt-1">
                  Live on{" "}
                  <a href={`/work#${r.slug}`}>the Our Work page</a> (allow up
                  to 5 minutes).
                </p>
              )}
              {r.error && <p className="mt-1 text-faint">{r.error}</p>}
              <div className="mt-2 flex gap-4">
                {(r.status === "failed" ||
                  r.status === "received" ||
                  r.stale) && (
                  <button
                    type="button"
                    className="btn btn--text"
                    onClick={() => void retry(r.id)}
                  >
                    Retry review
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn--text"
                  onClick={() => void withdraw(r.id)}
                >
                  Withdraw
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
