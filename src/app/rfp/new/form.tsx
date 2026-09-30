"use client";

// The intake control. One region is both the drop target and the textarea, so
// upload and paste are one affordance rather than two competing ones. Several
// files can be attached at once; they render as chips above the textarea, and
// the textarea itself never disappears, so pasted text and attachments travel
// together in the same submission.
//
// Reading a real RFP takes one to three minutes against the live brain (a
// long one more), so this posts, gets a 202, and then polls the document row. The wait is
// narrated honestly rather than hidden behind a spinner that implies seconds.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  RFP_MAX_FILES,
  RFP_MAX_TOTAL_BYTES,
  RFP_READ_BUDGET_MS,
  RFP_UPLOAD_ENVELOPE_BYTES,
} from "@/lib/rfp/intake";

/** Poll a minute past the server's read budget, so the server always
 *  answers (extracted or read_failed) before this screen gives up. */
const READ_POLL_MS = 3000;
const READ_POLL_TICKS = Math.ceil((RFP_READ_BUDGET_MS + 60_000) / READ_POLL_MS);
const READ_POLL_MINUTES = Math.round((READ_POLL_TICKS * READ_POLL_MS) / 60_000);

type Phase = "empty" | "sending" | "reading" | "failed";

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
            A real RFP takes one to three minutes, a long one several. You
            can leave; it keeps
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
  const [files, setFiles] = useState<File[]>([]);
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [slow, setSlow] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  // Mirror of `files` read by addFiles/removeFile, so two add events landing
  // between renders (a drop during a picker callback) can never compute the
  // next list from a stale snapshot and drop the first batch.
  const filesRef = useRef<File[]>([]);

  useEffect(() => {
    if (phase !== "reading") return;
    const t = window.setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [phase]);

  // Append candidates to the attachment list. Exact duplicates (same name,
  // size and lastModified) are skipped silently; every file refused at the
  // caps is named, none silently. The byte budget mirrors the server's
  // Content-Length precheck: file bytes PLUS the pasted text PLUS a framing
  // allowance, all from @/lib/rfp/intake so client and server cannot drift.
  const addFiles = useCallback(
    (incoming: File[]) => {
      const wasEmpty = filesRef.current.length === 0;
      const next = [...filesRef.current];
      const budget =
        RFP_MAX_TOTAL_BYTES -
        RFP_UPLOAD_ENVELOPE_BYTES -
        new Blob([text]).size;
      let total = next.reduce((n, f) => n + f.size, 0);
      const emptyRefused: string[] = [];
      const capRefused: string[] = [];
      let added = 0;
      for (const f of incoming) {
        const dup = next.some(
          (g) =>
            g.name === f.name &&
            g.size === f.size &&
            g.lastModified === f.lastModified
        );
        if (dup) continue;
        // A 0-byte file would be refused by the server at submit; say so now.
        if (f.size === 0) {
          emptyRefused.push(f.name);
          continue;
        }
        if (next.length >= RFP_MAX_FILES || total + f.size > budget) {
          capRefused.push(f.name);
          continue;
        }
        next.push(f);
        total += f.size;
        added += 1;
      }
      if (added > 0) {
        if (!title && wasEmpty) {
          setTitle(next[0].name.replace(/\.[^.]+$/, ""));
        }
        filesRef.current = next;
        setFiles(next);
      }
      const names = (list: string[]) => {
        const shown = list.slice(0, 3).map((n) => `"${n}"`);
        const more = list.length - shown.length;
        if (more > 0) return `${shown.join(", ")} and ${more} more`;
        if (shown.length > 1)
          return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
        return shown[0];
      };
      const sentences: string[] = [];
      if (emptyRefused.length > 0)
        sentences.push(
          `${names(emptyRefused)} ${emptyRefused.length === 1 ? "is empty and was" : "are empty and were"} not attached.`
        );
      if (capRefused.length > 0)
        sentences.push(
          `${names(capRefused)} ${capRefused.length === 1 ? "was" : "were"} not attached. Up to ${RFP_MAX_FILES} files fit, ${Math.round(RFP_MAX_TOTAL_BYTES / 1_000_000)} MB together with the pasted text.`
        );
      if (sentences.length > 0) setMessage(sentences.join(" "));
      else if (added > 0) setMessage("");
    },
    [text, title]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const dropped = Array.from(e.dataTransfer.files ?? []);
      if (dropped.length > 0) addFiles(dropped);
    },
    [addFiles]
  );

  function removeFile(index: number) {
    const next = filesRef.current.filter((_, i) => i !== index);
    filesRef.current = next;
    setFiles(next);
  }

  async function submit() {
    // Text typed AFTER the files were attached can push the body over the
    // server's Content-Length precheck; refuse here with honest copy instead
    // of letting the server 413 a selection the form accepted.
    const bodyBytes =
      files.reduce((n, f) => n + f.size, 0) +
      new Blob([text]).size +
      RFP_UPLOAD_ENVELOPE_BYTES;
    if (bodyBytes > RFP_MAX_TOTAL_BYTES) {
      setMessage(
        `Together the files and the pasted text are over ${Math.round(RFP_MAX_TOTAL_BYTES / 1_000_000)} MB. Remove a file or shorten the text.`
      );
      return;
    }
    setPhase("sending");
    setMessage("");
    // A retry is a FRESH read: without this the clock resumes at the failed
    // attempt's 6:00 and every step renders as already done.
    setElapsed(0);
    setSlow(false);
    const body = new FormData();
    for (const f of files) body.append("files", f);
    body.set("text", text);
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
    // A 202 whose body could not be parsed would otherwise strand the
    // reading screen forever: the poll loop would throw before it starts
    // and the give-up fallback would never fire.
    if (typeof data?.id !== "string") {
      setPhase("failed");
      setMessage(
        "The upload was accepted but the reply could not be read. Check Your RFPs in a minute; it may already be reading."
      );
      return;
    }

    setPhase("reading");
    const slowTimer = setTimeout(() => setSlow(true), 20_000);
    const id = data.id as string;
    // Poll until the background read finishes. Long RFPs genuinely take minutes.
    for (let i = 0; i < READ_POLL_TICKS; i++) {
      await new Promise((r) => setTimeout(r, READ_POLL_MS));
      const s = await fetch(`/api/rfp/documents/${id}/status`, {
        cache: "no-store",
      })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      // "extracted" alone is the exit: a document CAN legitimately extract
      // zero requirements, and waiting on a count here once left the user
      // staring at "reading" for minutes after the read had finished.
      if (s?.status === "extracted") {
        clearTimeout(slowTimer);
        router.push(`/rfp/r/${id}?draft=all`);
        return;
      }
      // The text is saved, so a failed read is retried from the RFP itself
      // ("Read it again"), never by uploading it a second time.
      if (s?.status === "read_failed") {
        clearTimeout(slowTimer);
        router.push(`/rfp/r/${id}`);
        return;
      }
    }
    clearTimeout(slowTimer);
    setPhase("failed");
    setMessage(
      `Still reading after ${READ_POLL_MINUTES} minutes. The RFP is saved under Your RFPs; open it and it follows the read to the end.`
    );
  }

  if (phase === "reading") {
    return <ReadingScreen elapsed={elapsed} slow={slow} />;
  }

  return (
    // The WHOLE panel is the drop target: with chips rendered above the
    // textarea, a drop released over a chip, the help line or the title field
    // would otherwise hit the browser default and navigate to the file,
    // destroying the typed text and the attachment list.
    <div
      className="panel panel--raised space-y-6"
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
    >
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
        {files.length > 0 && (
          <ul className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3">
            {files.map((f, i) => (
              <li
                key={`${f.name}\u0000${f.size}\u0000${f.lastModified}`}
                className="flex items-center gap-2"
              >
                <span className="mono text-sm">{f.name}</span>
                <span className="text-faint text-xs">
                  {Math.round(f.size / 1024)} KB
                </span>
                <button
                  type="button"
                  className="btn btn--text"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => removeFile(i)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          id="rfp-text"
          className="input min-h-64"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste the RFP text here, or drop PDF or Word files onto this box."
        />
        <p className="mt-2 text-xs text-faint">
          PDF, Word .docx, or pasted text (a few lines at least). Several
          files and text are read together as one RFP, up to about 120,000
          characters. Read only to draft this response; never stored in
          Tron&apos;s public memory.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          className="btn btn--primary"
          disabled={
            phase === "sending" ||
            (files.length === 0 && text.trim().length < 40)
          }
          onClick={submit}
        >
          {phase === "sending" ? "Sending" : "Read this RFP"}
        </button>
        <button
          type="button"
          className="btn btn--text"
          onClick={() => fileInput.current?.click()}
        >
          Choose files
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept=".pdf,.docx,.txt,.md"
          className="hidden"
          onChange={(e) => {
            const chosen = Array.from(e.target.files ?? []);
            if (chosen.length > 0) addFiles(chosen);
            // Reset so removing a file and choosing it again re-fires change.
            e.target.value = "";
          }}
        />
      </div>

      {message && (
        // role=alert: submit failures land here after the role=status reading
        // screen unmounts, and a screen-reader user would otherwise hear
        // nothing at all.
        <div className="panel panel--lightline-sand" role="alert">
          <p>{message}</p>
        </div>
      )}
    </div>
  );
}
