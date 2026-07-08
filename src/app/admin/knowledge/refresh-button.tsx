"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export function RefreshButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [runningSince, setRunningSince] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/knowledge/refresh")
      .then((r) => r.json())
      .then((d) => setRunningSince(d.running?.startedAt ?? null))
      .catch(() => {});
  }, []);

  async function start() {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/admin/knowledge/refresh", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setRunningSince(data.startedAt);
      setNote("Crawl started — it takes a few minutes; reload to see updated rows.");
      router.refresh();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Failed to start crawl");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="row flex-wrap" style={{ gap: "var(--sp-3)" }}>
      <button className="btn btn--primary" onClick={start} disabled={busy || !!runningSince}>
        {runningSince ? "Crawl running…" : busy ? "Starting…" : "Run knowledge crawl now"}
      </button>
      {runningSince && (
        <span className="text-xs text-dim">running since {runningSince}</span>
      )}
      {note && <span className="text-xs text-dim">{note}</span>}
    </div>
  );
}
