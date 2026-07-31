"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function AddKnowledge() {
  const router = useRouter();
  const [kind, setKind] = useState<"fact" | "choice">("choice");
  const [statement, setStatement] = useState("");
  const [factKey, setFactKey] = useState("");
  const [detail, setDetail] = useState("");
  const [polarity, setPolarity] = useState<"affirmative" | "negative">(
    "affirmative"
  );
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(submit: boolean) {
    setBusy(true);
    setMsg("");
    const res = await fetch("/api/rfp/knowledge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind,
        statement,
        factKey: kind === "fact" ? factKey : null,
        detail,
        polarity,
        submit,
      }),
    });
    setBusy(false);
    const d = await res.json().catch(() => null);
    if (!res.ok) {
      setMsg(d?.message ?? "That was not saved.");
      return;
    }
    setStatement("");
    setDetail("");
    setFactKey("");
    router.refresh();
  }

  return (
    <div className="panel panel--raised space-y-5">
      <span className="sys-label">Add something</span>

      <div className="field">
        <label htmlFor="k-kind">What kind</label>
        <select
          id="k-kind"
          className="input"
          value={kind}
          onChange={(e) => setKind(e.target.value as "fact" | "choice")}
        >
          <option value="choice">
            A decision about one proposal (stays yours)
          </option>
          <option value="fact">
            A fact about XL.net (can be approved into the shared base)
          </option>
        </select>
        <p className="mt-2 text-xs text-faint">
          A decision about one client is not a company fact. Getting that
          backwards puts a one-off into every future proposal, so the default
          is the safer one.
        </p>
      </div>

      {kind === "fact" && (
        <>
          <div className="field">
            <label htmlFor="k-key">Fact key</label>
            <input
              id="k-key"
              className="input mono"
              value={factKey}
              onChange={(e) => setFactKey(e.target.value)}
              placeholder="support.response-time"
            />
          </div>
          <div className="field">
            <label htmlFor="k-pol">Is this something XL.net does?</label>
            <select
              id="k-pol"
              className="input"
              value={polarity}
              onChange={(e) =>
                setPolarity(e.target.value as "affirmative" | "negative")
              }
            >
              <option value="affirmative">Yes, XL.net does this</option>
              <option value="negative">
                No, and that is worth recording
              </option>
            </select>
          </div>
        </>
      )}

      <div className="field">
        <label htmlFor="k-stmt">The statement</label>
        <textarea
          id="k-stmt"
          className="input min-h-24"
          value={statement}
          onChange={(e) => setStatement(e.target.value)}
          placeholder="XL.net answers priority-one tickets within 15 minutes during business hours."
        />
      </div>

      <div className="field">
        <label htmlFor="k-detail">Anything a drafter should know (optional)</label>
        <textarea
          id="k-detail"
          className="input min-h-16"
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
        />
      </div>

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          className="btn btn--text"
          disabled={busy || statement.trim().length < 10}
          onClick={() => save(false)}
        >
          Keep it to myself
        </button>
        {kind === "fact" && (
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || statement.trim().length < 10 || !factKey.trim()}
            onClick={() => save(true)}
          >
            Send for approval
          </button>
        )}
      </div>

      {msg && <p className="text-sm">{msg}</p>}
    </div>
  );
}
