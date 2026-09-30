"use client";

// The workspace panel for a document with no structure yet because its read
// failed or is still running. A failed (or orphaned) read gets "Read it
// again", which re-reads the stored text: nothing is uploaded twice. While a
// read runs, the panel follows it and opens the finished RFP by itself.

import { useEffect, useState } from "react";

const POLL_MS = 4000;

export function ReadAgain({
  documentId,
  initialStatus,
}: {
  documentId: string;
  initialStatus: string;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (status === "read_failed" || stale) return;
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
        // first read does (it drafts nothing if sections already exist).
        window.location.assign(`/rfp/r/${documentId}?draft=all`);
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

  const canRetry = status === "read_failed" || (status === "reading" && stale);

  return (
    <div className="panel">
      {status === "read_failed" ? (
        <p className="text-faint">
          This RFP was saved, but reading it for its structure did not finish.
          The text is kept, so it can be read again without uploading it.
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
