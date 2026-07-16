"use client";

// Save/Download affordance. A plain disclosure (critique S7): a button with
// aria-expanded toggling a list of ordinary links; Escape closes and restores
// focus; NO menu roles. Links hit the download route directly, so downloads
// work through every outage and the kill switch. Enabled from drafting
// onward; before that, a visible reason accompanies the disabled trigger.

import { useEffect, useRef, useState } from "react";
import type { GovernanceDoc, ProjectStatus } from "@/lib/governance/types";
import { fmtDate } from "./shared";

const faint = { color: "var(--xl-text-faint)" } as const;

function Chevron() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3 shrink-0" aria-hidden="true">
      <path
        d="M2 4l4 4 4-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}

export function DownloadMenu({
  projectId,
  documents,
  status,
  deletesAt,
}: {
  projectId: string;
  documents: GovernanceDoc[];
  status: ProjectStatus;
  deletesAt: string;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const enabled =
    (status === "drafting" || status === "review" || status === "done") &&
    documents.length > 0;

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus();
      }
    }
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node))
        setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  if (!enabled) {
    return (
      <span className="inline-flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn"
          aria-disabled="true"
          style={{ opacity: 0.55, cursor: "default" }}
          onClick={(e) => e.preventDefault()}
        >
          Download
        </button>
        <span className="text-xs" style={faint}>
          Nothing to download yet
        </span>
      </span>
    );
  }

  const base = `/api/governance/projects/${encodeURIComponent(projectId)}/download`;

  if (documents.length === 1) {
    return (
      <a
        className="btn no-underline"
        href={`${base}?format=docx&doc=${encodeURIComponent(documents[0].slug)}`}
      >
        Download .docx
      </a>
    );
  }

  return (
    <div className="relative" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className="btn"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        Download
        <Chevron />
      </button>
      {open && (
        <div className="panel panel--raised absolute right-0 z-30 mt-2 w-80 max-w-[90vw] p-4 text-left">
          <ul>
            <li>
              <a
                className="flex min-h-11 items-center justify-between gap-4 no-underline"
                href={`${base}?format=zip`}
                onClick={() => setOpen(false)}
              >
                Everything as .zip
                <span className="mono text-xs" style={faint}>
                  {documents.length} documents
                </span>
              </a>
            </li>
          </ul>
          <hr className="rule" style={{ margin: "var(--sp-2) 0" }} />
          <ul>
            {documents.map((d) => (
              <li key={d.slug}>
                <a
                  className="flex min-h-11 items-center no-underline"
                  href={`${base}?format=docx&doc=${encodeURIComponent(d.slug)}`}
                  onClick={() => setOpen(false)}
                >
                  {d.title} · .docx
                </a>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs" style={faint}>
            Word-friendly files. What you download is yours forever; our copy
            auto-deletes {fmtDate(deletesAt)}. Downloading counts as activity
            and moves that date forward.
          </p>
        </div>
      )}
    </div>
  );
}
