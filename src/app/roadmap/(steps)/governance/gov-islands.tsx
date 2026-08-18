"use client";

// Client islands for roadmap step 1 (§5.18): document upload (admin),
// link-a-policy (admin), attach-own-project (member-actionable), and the
// two-click remove (admin).
// Every mutation calls the API and then router.refresh() so the server page
// re-renders the on-file list; the islands hold no copy of company data.

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type ApiError = { error?: { code?: string; message?: string } };

async function readError(res: Response): Promise<string> {
  const data = (await res.json().catch(() => null)) as ApiError | null;
  return data?.error?.message ?? "Something went wrong. Try again shortly.";
}

export function UploadDocCard() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      setError("Attach the document file.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("title", title);
      const res = await fetch("/api/roadmap/docs", {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      setNotice("On file.");
      setTitle("");
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      router.refresh();
    } catch {
      setError("The upload did not complete. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-4 space-y-3">
      <input
        className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm"
        style={{ borderColor: "var(--xl-line)" }}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={120}
        placeholder="Document title (optional; the file name works too)"
        aria-label="Document title"
      />
      <input
        ref={fileRef}
        type="file"
        accept=".pdf,.doc,.docx,.md,.markdown,.txt"
        aria-label="Governance document file"
        className="w-full text-sm"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />
      <p className="text-xs text-faint">.pdf, .docx, .md, or .txt, up to 10 MB.</p>
      <button type="submit" className="btn" disabled={busy} aria-busy={busy}>
        {busy ? "Uploading..." : "Upload document"}
      </button>
      {notice && (
        <p role="status" className="text-xs text-faint">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
    </form>
  );
}

export function LinkDocCard() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) {
      setError("Enter the address of the policy.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/roadmap/docs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, title }),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      setNotice("On file.");
      setUrl("");
      setTitle("");
      router.refresh();
    } catch {
      setError("The link did not save. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-4 space-y-3">
      <input
        type="url"
        className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm"
        style={{ borderColor: "var(--xl-line)" }}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        maxLength={500}
        placeholder="https://..."
        aria-label="Policy address"
      />
      <input
        className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm"
        style={{ borderColor: "var(--xl-line)" }}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={120}
        placeholder="Link title (optional; the site name works too)"
        aria-label="Link title"
      />
      <p className="text-xs text-faint">
        A sign-in wall is fine. We only confirm the address goes to a page,
        we never read what is behind it.
      </p>
      <button type="submit" className="btn" disabled={busy} aria-busy={busy}>
        {busy ? "Checking..." : "Link the policy"}
      </button>
      {notice && (
        <p role="status" className="text-xs text-faint">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
    </form>
  );
}

export function AttachProjectButton({
  projectId,
  attached,
}: {
  projectId: string;
  attached: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (attached || done) {
    return <span className="mono text-xs text-faint">Attached</span>;
  }

  async function attach() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/roadmap/docs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ governanceProjectId: projectId }),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      setDone(true);
      router.refresh();
    } catch {
      setError("Something went wrong. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-3">
      <button
        type="button"
        className="btn btn--text"
        disabled={busy}
        aria-busy={busy}
        onClick={attach}
      >
        {busy ? "Attaching..." : "Attach"}
      </button>
      {error && (
        <span role="alert" className="text-xs text-red-400">
          {error}
        </span>
      )}
    </span>
  );
}

export function RemoveDocButton({ docId }: { docId: string }) {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/roadmap/docs/${docId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      router.refresh();
    } catch {
      setError("Something went wrong. Check your connection and try again.");
    } finally {
      setBusy(false);
      setArmed(false);
    }
  }

  if (!armed) {
    return (
      <button
        type="button"
        className="btn btn--text"
        onClick={() => setArmed(true)}
      >
        Remove
      </button>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-3">
      <button
        type="button"
        className="btn btn--text"
        disabled={busy}
        aria-busy={busy}
        onClick={remove}
      >
        {busy ? "Removing..." : "Confirm remove"}
      </button>
      {!busy && (
        <button
          type="button"
          className="btn btn--text"
          onClick={() => setArmed(false)}
        >
          Keep it
        </button>
      )}
      {error && (
        <span role="alert" className="text-xs text-red-400">
          {error}
        </span>
      )}
    </span>
  );
}
