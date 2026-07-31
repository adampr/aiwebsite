"use client";

// The intake control. One region is both the drop target and the textarea, so
// upload and paste are one affordance rather than two competing ones.
//
// Reading a real RFP takes about a minute and a half against the live brain,
// so this posts, gets a 202, and then polls the document row. The wait is
// narrated honestly rather than hidden behind a spinner that implies seconds.

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Phase = "empty" | "file" | "sending" | "reading" | "failed";

export function NewRfpForm() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("empty");
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [slow, setSlow] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) {
      setFile(f);
      setPhase("file");
      if (!title) setTitle(f.name.replace(/\.[^.]+$/, ""));
    }
  }, [title]);

  async function submit() {
    setPhase("sending");
    setMessage("");
    const body = new FormData();
    if (file) body.set("file", file);
    else body.set("text", text);
    body.set("title", title);

    let res: Response;
    try {
      res = await fetch("/api/rfp/documents", { method: "POST", body });
    } catch {
      setPhase("failed");
      setMessage("The upload did not reach the server. Nothing was saved.");
      return;
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setPhase("failed");
      setMessage(data?.message ?? "That could not be read. Nothing was saved.");
      return;
    }

    setPhase("reading");
    const slowTimer = setTimeout(() => setSlow(true), 20_000);
    const id = data.id as string;
    // Poll until the background read finishes. Long RFPs genuinely take minutes.
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const s = await fetch(`/api/rfp/documents/${id}/status`, {
        cache: "no-store",
      })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (s?.status === "extracted" && s.requirements > 0) {
        clearTimeout(slowTimer);
        router.push(`/rfp/r/${id}`);
        return;
      }
      if (s?.status === "read_failed") {
        clearTimeout(slowTimer);
        setPhase("failed");
        setMessage(
          "The RFP was saved but could not be read for its structure. Open it and try again."
        );
        return;
      }
    }
    clearTimeout(slowTimer);
    router.push(`/rfp/r/${id}`);
  }

  if (phase === "reading") {
    return (
      <div className="panel panel--raised" role="status" aria-live="polite">
        <p>
          Reading the RFP. Pulling out its structure and every question it
          asks.
        </p>
        {slow && (
          <p className="mt-3 text-sm text-faint">
            Still reading. A long RFP takes a couple of minutes, and this page
            moves on by itself when it is done.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="panel panel--raised space-y-6">
      <div className="field">
        <label htmlFor="rfp-title">Name it</label>
        <input
          id="rfp-title"
          className="input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Cordia Senior Living, managed IT"
        />
      </div>

      <div className="field">
        <label htmlFor="rfp-text">The RFP</label>
        {file ? (
          <div className="flex flex-wrap items-center gap-4 py-3">
            <span className="mono text-sm">{file.name}</span>
            <span className="text-faint text-xs">
              {Math.round(file.size / 1024)} KB
            </span>
            <button
              type="button"
              className="btn btn--text"
              onClick={() => {
                setFile(null);
                setPhase("empty");
              }}
            >
              Remove
            </button>
          </div>
        ) : (
          <textarea
            id="rfp-text"
            className="input min-h-64"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onDrop={onDrop}
            onDragOver={(e) => e.preventDefault()}
            placeholder="Paste the RFP text here, or drop a PDF or Word file onto this box."
          />
        )}
        <p className="mt-2 text-xs text-faint">
          PDF, Word .docx, or pasted text. Nothing leaves XL.net.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          className="btn btn--primary"
          disabled={phase === "sending" || (!file && text.trim().length < 40)}
          onClick={submit}
        >
          {phase === "sending" ? "Sending" : "Read this RFP"}
        </button>
        <button
          type="button"
          className="btn btn--text"
          onClick={() => fileInput.current?.click()}
        >
          Choose a file
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".pdf,.docx,.txt,.md"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) {
              setFile(f);
              setPhase("file");
              if (!title) setTitle(f.name.replace(/\.[^.]+$/, ""));
            }
          }}
        />
      </div>

      {message && (
        <div className="panel panel--lightline-sand">
          <p>{message}</p>
        </div>
      )}
    </div>
  );
}
