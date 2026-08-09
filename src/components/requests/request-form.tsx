"use client";

// The request-a-project form (§5.19), shared by /work/requested and
// /roadmap/request. Title, description, estimated annual value (whole USD),
// and one or more metric lines explaining how the value is calculated
// (add/remove). Bounds mirror validateRequestBody; the server re-validates
// everything. On success the form clears and router.refresh() re-renders
// the server-rendered lists around it.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { REQUEST_CAPS } from "@/lib/work/requests-config";

export function RequestForm({ openCount }: { openCount: number }) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [value, setValue] = useState("");
  const [metrics, setMetrics] = useState<string[]>([""]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const atCap = openCount >= REQUEST_CAPS.openPerRequester;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const res = await fetch("/api/work/requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          description,
          value: Number(value),
          metrics,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(data?.error?.message ?? "That did not work. Try again.");
      } else {
        setTitle("");
        setDescription("");
        setValue("");
        setMetrics([""]);
        setDone(true);
        router.refresh();
      }
    } catch {
      setError("Network problem. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {atCap && (
        <p className="text-sm text-faint">
          You have {REQUEST_CAPS.openPerRequester} open requests, the maximum.
          Cancel a pending one or wait for one to be completed before filing
          another.
        </p>
      )}
      <div>
        <label
          htmlFor="req-title"
          className="mono text-xs uppercase tracking-[0.2em] text-light"
        >
          Title
        </label>
        <input
          id="req-title"
          className="input mt-2 w-full"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={REQUEST_CAPS.titleMaxChars}
          required
          minLength={REQUEST_CAPS.titleMinChars}
          placeholder="Short name for the project"
        />
      </div>
      <div>
        <label
          htmlFor="req-desc"
          className="mono text-xs uppercase tracking-[0.2em] text-light"
        >
          Description
        </label>
        <textarea
          id="req-desc"
          className="input mt-2 w-full"
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={REQUEST_CAPS.descriptionMaxChars}
          required
          placeholder="What should be built, and for whom?"
        />
      </div>
      <div>
        <label
          htmlFor="req-value"
          className="mono text-xs uppercase tracking-[0.2em] text-light"
        >
          Estimated annual value (USD)
        </label>
        <input
          id="req-value"
          className="input mt-2 w-full"
          type="number"
          inputMode="numeric"
          min={0}
          max={REQUEST_CAPS.valueMaxUsd}
          step={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          required
          placeholder="12500"
        />
      </div>
      <fieldset>
        <legend className="mono text-xs uppercase tracking-[0.2em] text-light">
          How the value is calculated
        </legend>
        <p className="mt-1 text-xs text-faint">
          One or more metrics, e.g. 2 hrs/week saved x 4 techs x $85/hr.
        </p>
        <div className="mt-2 space-y-2">
          {metrics.map((m, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                className="input w-full"
                aria-label={`Metric ${i + 1}`}
                value={m}
                maxLength={REQUEST_CAPS.metricMaxChars}
                onChange={(e) =>
                  setMetrics(metrics.map((x, j) => (j === i ? e.target.value : x)))
                }
              />
              {metrics.length > 1 && (
                <button
                  type="button"
                  className="btn btn--text"
                  aria-label={`Remove metric ${i + 1}`}
                  onClick={() =>
                    setMetrics(metrics.filter((_, j) => j !== i))
                  }
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
        {metrics.length < REQUEST_CAPS.metricsMaxCount && (
          <button
            type="button"
            className="btn btn--text mt-2"
            onClick={() => setMetrics([...metrics, ""])}
          >
            Add another metric
          </button>
        )}
      </fieldset>
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      {done && !error && (
        <p className="text-sm" role="status">
          Request filed. It goes on the board once an admin approves it.
        </p>
      )}
      {/* aria-busy too: .btn[aria-disabled="true"] is inert styling, and
          the aria-busy twin is what keeps "working" reading differently
          from "unavailable" (futurism.css). */}
      <button
        type="submit"
        className="btn btn--primary"
        aria-disabled={busy}
        aria-busy={busy}
      >
        {busy ? "Filing..." : "File the request"}
      </button>
    </form>
  );
}
