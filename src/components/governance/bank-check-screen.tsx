"use client";

// Bank-check pause screen (§5.12 FFIEC): research detected a likely bank on
// a non-FFIEC project and paused BEFORE turn zero. This standalone centered
// card is the only pending work: nothing runs, no Stop renders (Stop is
// RUN-gated, round 15e), and the decision is deterministic and synchronous
// (no 202/poll). Only the exact chips or Skip resolve it; the server
// re-presents the card with its error copy for anything else, because the
// choice is final for the project and a guessed branch would be
// unrecoverable.

import { useState } from "react";
import {
  BANK_CHECK_CONTEXT_LINE,
  BANK_CHECK_EVIDENCE_FINEPRINT,
  BANK_CHECK_EVIDENCE_LABEL,
  BANK_CHECK_STAY_NOTE,
  BANK_CHECK_STAY_RECEIPT,
  BANK_CHECK_SWITCH_NOTE,
  BANK_CHECK_SWITCH_RECEIPT,
  BANK_CHECK_WAIT_FINEPRINT,
} from "@/lib/governance/config";
import type { ProjectView } from "@/lib/governance/types";
import { api } from "./shared";

const faint = { color: "var(--xl-text-faint)" } as const;
const dim = { color: "var(--xl-text-dim)" } as const;

export function BankCheckScreen({
  view,
  onDecided,
  onAnnounce,
}: {
  view: ProjectView;
  onDecided: () => void; // refetch; the row is queued/researching again
  onAnnounce: (msg: string) => void;
}) {
  const q = view.nextQuestion;
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!q) return null;

  const submit = async (skipped: boolean) => {
    if (busy) return;
    setBusy(true);
    setError("");
    const r = await api<{ ok: true; decision: "switch" | "continue" }>(
      `/api/governance/projects/${view.id}/answer`,
      {
        method: "POST",
        body: JSON.stringify({
          mode: "async",
          questionId: q.id,
          answer: skipped ? "" : answer.trim(),
          skipped,
        }),
      }
    );
    setBusy(false);
    if (!r.ok) {
      // invalid_request re-presents the card with the server's copy; a 409
      // means another tab already decided: refetch resolves both honestly.
      setError(r.message);
      if (r.status === 409) onDecided();
      return;
    }
    onAnnounce(
      r.data.decision === "switch"
        ? BANK_CHECK_SWITCH_RECEIPT
        : BANK_CHECK_STAY_RECEIPT
    );
    onDecided();
  };

  return (
    <div className="panel mx-auto mt-8 max-w-2xl">
      <p className="text-xs" style={dim}>
        {BANK_CHECK_CONTEXT_LINE}
      </p>
      <h3 className="mt-4 text-base">{q.text}</h3>
      <p className="mt-2 max-w-none text-sm" style={dim}>
        {q.why}
      </p>

      {view.bankCheckEvidence && view.bankCheckEvidence.length > 0 && (
        <div className="q-snapshot mt-4">
          <span className="sys-label sys-label--warn">
            {BANK_CHECK_EVIDENCE_LABEL}
          </span>
          <ul className="mt-2 list-none space-y-1 p-0 text-sm">
            {view.bankCheckEvidence.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="mt-2 max-w-none text-xs" style={faint}>
            {BANK_CHECK_EVIDENCE_FINEPRINT}
          </p>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {q.suggestions.map((s) => (
          <button
            key={s}
            type="button"
            className="gov-chip"
            aria-pressed={answer.trim() === s}
            disabled={busy}
            onClick={() => setAnswer(s)}
          >
            {s}
          </button>
        ))}
      </div>
      <p className="mt-3 max-w-none text-xs" style={faint}>
        {BANK_CHECK_SWITCH_NOTE}
      </p>
      <p className="mt-1 max-w-none text-xs" style={faint}>
        {BANK_CHECK_STAY_NOTE}
      </p>

      <form
        className="mt-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(false);
        }}
      >
        <textarea
          className="input w-full"
          rows={2}
          maxLength={2000}
          placeholder="Tap one of the two options above."
          aria-label="Your choice"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          disabled={busy}
        />
        {error && (
          <p className="mt-2 max-w-none text-sm" style={{ color: "var(--xl-danger)" }} role="alert">
            {error}
          </p>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-6">
          <button
            type="submit"
            className="btn btn--primary btn--stable"
            aria-busy={busy || undefined}
            disabled={busy || !answer.trim()}
          >
            {busy ? "Sending..." : "Send"}
          </button>
          <button
            type="button"
            className="btn btn--text"
            disabled={busy}
            onClick={() => void submit(true)}
          >
            Skip
          </button>
        </div>
      </form>
      <p className="mt-4 max-w-none text-xs" style={faint}>
        {BANK_CHECK_WAIT_FINEPRINT}
      </p>
    </div>
  );
}
