"use client";

// The intake control. One region is both the drop target and the textarea, so
// upload and paste are one affordance rather than two competing ones.
//
// Reading a real RFP takes about a minute and a half against the live brain,
// so this posts, gets a 202, and then polls the document row. The wait is
// narrated honestly rather than hidden behind a spinner that implies seconds.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Phase = "empty" | "file" | "sending" | "reading" | "failed";

/** Step glyph, borrowed from the governance research screen. */
function Glyph({ state }: { state: "pending" | "active" | "done" }) {
  if (state === "done")
    return (
      <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0" aria-hidden="true">
        <path
          d="M3 8.5 6.5 12 13 4.5"
          fill="none"
          stroke="var(--xl-ok)"
          strokeWidth="1.5"
        />
      </svg>
    );
  if (state === "active")
    return (
      <span
        className="dot shrink-0"
        style={{ color: "var(--xl-light)" }}
        aria-hidden="true"
      />
    );
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r="4"
        fill="none"
        stroke="var(--xl-line-bright)"
        strokeWidth="1"
      />
    </svg>
  );
}

/**
 * The reading wait, in the governance research screen's visual language:
 * radar, a step list, an elapsed clock. The read is ONE model call with no
 * intermediate signal, so the steps advance on elapsed time — they narrate
 * the phases of that one call in the order it performs them, and only the
 * final state comes from the server.
 */
function ReadingScreen({ elapsed, slow }: { elapsed: number; slow: boolean }) {
  const steps = [
    { label: "RFP saved", at: 0 },
    { label: "Reading it end to end", at: 1 },
    { label: "Pulling out the client's structure, labels verbatim", at: 45 },
    { label: "Listing every ask, one requirement at a time", at: 80 },
  ];
  const mm = Math.floor(elapsed / 60);
  const ss = String(elapsed % 60).padStart(2, "0");
  return (
    <div className="panel panel--lightline" role="status" aria-live="polite">
      <div className="flex flex-col items-start gap-8 sm:flex-row">
        <div className="radar mx-auto shrink-0" aria-hidden="true">
          <i className="radar-blip" style={{ left: "62%", top: "34%" }} />
          <i
            className="radar-blip radar-blip--sand"
            style={{ left: "30%", top: "58%" }}
          />
        </div>
        <div className="min-w-0 flex-1">
          <span className="sys-label">Tron is reading</span>
          <h2 className="mt-4">Every ask, in the client&apos;s own words</h2>
          <p className="mt-4 text-sm">
            A real RFP takes one to three minutes. You can leave; it keeps
            reading, and the RFP appears under Your RFPs when it is done.
            Stay, and drafting starts by itself.
          </p>
          <ul className="mt-6 space-y-3">
            {steps.map((step, i) => {
              const next = steps[i + 1];
              const state: "pending" | "active" | "done" =
                elapsed >= step.at && (!next || elapsed < next.at)
                  ? i === 0
                    ? "done"
                    : "active"
                  : elapsed >= (next?.at ?? Infinity) || i === 0
                    ? "done"
                    : "pending";
              return (
                <li
                  key={step.label}
                  className="flex items-center gap-3"
                  aria-current={state === "active" ? "step" : undefined}
                >
                  <Glyph state={state} />
                  <span
                    className="text-sm"
                    style={
                      state === "pending"
                        ? { color: "var(--xl-text-faint)" }
                        : undefined
                    }
                  >
                    {step.label}
                  </span>
                </li>
              );
            })}
          </ul>
          {/* aria-hidden: the clock changes every second and would make the
              live region announce the whole panel once per second, burying
              the step transitions that actually matter. */}
          <p
            className="mono mt-6 text-xs"
            style={{ color: "var(--xl-text-faint)" }}
            aria-hidden="true"
          >
            {mm}:{ss}
            {slow ? " · long RFPs genuinely take this long" : ""}
          </p>
        </div>
      </div>
    </div>
  );
}

export function NewRfpForm() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("empty");
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [slow, setSlow] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (phase !== "reading") return;
    const t = window.setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [phase]);

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
    // A retry is a FRESH read: without this the clock resumes at the failed
    // attempt's 6:00 and every step renders as already done.
    setElapsed(0);
    setSlow(false);
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
      // "extracted" alone is the exit: a document CAN legitimately extract
      // zero requirements, and waiting on a count here once left the user
      // staring at "reading" for six minutes after the read had finished.
      if (s?.status === "extracted") {
        clearTimeout(slowTimer);
        router.push(`/rfp/r/${id}?draft=all`);
        return;
      }
      if (s?.status === "read_failed") {
        clearTimeout(slowTimer);
        setPhase("failed");
        setMessage(
          "The RFP was saved but could not be read for its structure. That is usually a brief drafting-service outage. Start it again from New RFP; pasting the same text works."
        );
        return;
      }
    }
    clearTimeout(slowTimer);
    setPhase("failed");
    setMessage(
      "Still reading after six minutes. The RFP is saved under Your RFPs; open it once its status shows Read, and start drafting from there."
    );
  }

  if (phase === "reading") {
    return <ReadingScreen elapsed={elapsed} slow={slow} />;
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
          placeholder="Client name, managed IT"
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
          PDF, Word .docx, or pasted text. Read only to draft this response;
          never stored in Tron&apos;s public memory.
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
