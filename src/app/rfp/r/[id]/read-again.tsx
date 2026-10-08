"use client";

// The workspace panel for a document with no structure: its read failed, is
// still running, or finished without a section structure (§5.17.17). A
// failed, orphaned or empty read gets "Read it again", which re-reads the
// stored text: nothing is uploaded twice. While a read runs, the panel
// follows it and opens the finished RFP by itself.

import { useEffect, useState } from "react";

const POLL_MS = 4000;

export function ReadAgain({
  documentId,
  initialStatus,
  requirementCount,
}: {
  documentId: string;
  initialStatus: string;
  /** What the finished read found; shown only for an empty "extracted". */
  requirementCount: number;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    // "extracted" here means read but empty: the status route already says
    // extracted, so following it would reload this page forever.
    if (status === "read_failed" || status === "extracted" || stale) return;
    let stopped = false;
    const tick = async () => {
      const s = await fetch(`/api/rfp/documents/${documentId}/status`, {
        cache: "no-store",
      })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (stopped || !s) return;
      if (s.status === "extracted") {
        // A full load, not a refresh: the workspace seeds its state from the
        // server props once, and ?draft=all starts drafting exactly as a
        // first read does (it drafts nothing if sections already exist). A
        // read that found no structure again loads without it, to show the
        // fresh requirement count in this panel.
        window.location.assign(
          s.structureNodes > 0
            ? `/rfp/r/${documentId}?draft=all`
            : `/rfp/r/${documentId}`
        );
        return;
      }
      if (s.status === "read_failed") setStatus("read_failed");
      else if (s.readStale === true) setStale(true);
    };
    void tick();
    const timer = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [documentId, status, stale]);

  async function readAgain() {
    setBusy(true);
    setError("");
    const res = await fetch(`/api/rfp/documents/${documentId}/read`, {
      method: "POST",
    }).catch(() => null);
    setBusy(false);
    if (!res) {
      setError("That did not reach the server. Try again in a moment.");
      return;
    }
    const data = await res.json().catch(() => null);
    if (res.status === 202 || data?.error === "busy") {
      setStale(false);
      setStatus("reading");
      return;
    }
    if (data?.error === "already_read") {
      window.location.assign(`/rfp/r/${documentId}`);
      return;
    }
    setError(data?.message ?? "That could not be started. Try again in a moment.");
  }

  const canRetry =
    status === "read_failed" ||
    status === "extracted" ||
    (status === "reading" && stale);

  return (
    <div className="panel">
      {status === "read_failed" ? (
        <p className="text-faint">
          This RFP was saved, but reading it for its structure did not finish.
          The text is kept, so it can be read again without uploading it.
        </p>
      ) : status === "extracted" && requirementCount === 0 ? (
        <p className="text-faint">
          This document was read, but the read found no requirements and no
          section structure, so there is nothing to draft from. The text is
          kept, so it can be read again.
        </p>
      ) : status === "extracted" ? (
        <p className="text-faint">
          This document was read but no sections could be drafted from it
          (the read found {requirementCount} requirement
          {requirementCount === 1 ? "" : "s"}{" "}
          and no section structure). Read it again: text with no headings of
          its own is drafted into {"XL.net's"} standard proposal sections.
        </p>
      ) : status === "reading" && stale ? (
        <p className="text-faint">
          Reading this RFP stopped partway, most likely because the service
          restarted. The text is kept, so it can be read again.
        </p>
      ) : (
        <p className="text-faint" role="status">
          Still reading this RFP. A long one takes several minutes; this page
          opens the draft by itself when the structure is out.
        </p>
      )}
      {canRetry && (
        <button
          type="button"
          className="btn btn--primary mt-3"
          onClick={() => void readAgain()}
          disabled={busy}
        >
          {busy ? "Starting…" : "Read it again"}
        </button>
      )}
      {error && (
        <p className="mt-2 text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
