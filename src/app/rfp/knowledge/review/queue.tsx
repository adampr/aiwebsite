"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { When } from "@/components/when";

type Item = {
  id: string;
  statement: string;
  detail: string | null;
  factKey: string | null;
  polarity: string;
  category: string;
  owner: string;
  /** ISO-8601 instant, NOT a formatted age: the server page cannot format it
   * (see the comment there), so this island does, through <When />. */
  createdAt: string;
  conflict: string | null;
};

export function ReviewQueue({ items }: { items: Item[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");

  async function act(id: string, body: Record<string, unknown>) {
    setBusy(id);
    setMsg("");
    const res = await fetch(`/api/rfp/knowledge/${id}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(null);
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      setMsg(d?.message ?? "That did not go through.");
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {msg && (
        <div className="panel panel--lightline-sand">
          <p>{msg}</p>
        </div>
      )}
      {items.map((it) => (
        <div className="panel" key={it.id}>
          <p className="text-lg">{it.statement}</p>
          {it.detail && <p className="mt-2 text-sm text-faint">{it.detail}</p>}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            {it.factKey && <span className="mono text-xs">{it.factKey}</span>}
            <span className="badge">{it.category}</span>
            {it.polarity === "negative" && (
              <span className="badge badge--warn">
                Negative · this becomes a blocking rule
              </span>
            )}
            <span className="text-xs text-faint">
              {it.owner} · <When iso={it.createdAt} />
            </span>
          </div>

          {it.conflict && (
            <div className="panel panel--lightline-sand mt-4">
              <span className="sys-label">Already on file under this key</span>
              <p className="mt-2 text-sm">{it.conflict}</p>
              <p className="mt-2 text-xs text-faint">
                Approving adds a second fact with the same key. Usually the
                right move is to return this and correct the existing one.
              </p>
            </div>
          )}

          <div className="mt-5 flex flex-wrap gap-3">
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy === it.id}
              onClick={() => act(it.id, { action: "approve", confidence: "confirmed" })}
            >
              Approve into the shared base
            </button>
            <button
              type="button"
              className="btn btn--sand"
              disabled={busy === it.id}
              onClick={() =>
                act(it.id, { action: "approve", confidence: "needs-adam" })
              }
            >
              Approve as needs confirmation
            </button>
          </div>

          <div className="mt-4 flex flex-wrap items-end gap-3">
            <div className="field flex-1 min-w-64">
              <label htmlFor={`n-${it.id}`}>Or send it back, with a reason</label>
              <input
                id={`n-${it.id}`}
                className="input"
                value={note[it.id] ?? ""}
                onChange={(e) =>
                  setNote((p) => ({ ...p, [it.id]: e.target.value }))
                }
              />
            </div>
            <button
              type="button"
              className="btn btn--text"
              disabled={busy === it.id || (note[it.id] ?? "").trim().length < 3}
              onClick={() =>
                act(it.id, { action: "return", note: note[it.id] })
              }
            >
              Return
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
