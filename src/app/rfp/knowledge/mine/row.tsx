"use client";

// One row on /rfp/knowledge/mine, with everything its owner may do to it
// (ARCHITECTURE.md §5.17.9): edit in place, send for approval or withdraw,
// delete, and for an admin promote straight into the shared base. Approved
// rows show the shared fact's CURRENT text and hand an admin the Shared
// tab's Correct / Retire controls for it, because the proposal row is frozen
// once its fact has been minted.

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { When } from "@/components/when";
import { FactActions } from "../edit";
import { KNOWLEDGE_CATEGORIES } from "@/lib/rfp/knowledge-mine";

export type MineRow = {
  id: string;
  status: string;
  kind: string;
  factKey: string | null;
  category: string;
  statement: string;
  detail: string | null;
  polarity: string;
  /** ISO instant; formatted client-side by <When /> (timestamp rules). */
  createdAt: string;
  reviewedBy: string | null;
  reviewNote: string | null;
  /** The LIVE shared fact under this row's key, when it is not this row's own. */
  conflict: string | null;
  /** For approved rows: where the minted fact stands today. */
  promoted: {
    id: string;
    live: boolean;
    statement: string;
    detail: string | null;
    polarity: string;
    category: string;
  } | null;
};

const STATUS: Record<string, { label: string; cls: string }> = {
  private: { label: "Yours only", cls: "badge" },
  submitted: { label: "Awaiting approval", cls: "badge badge--warn" },
  approved: { label: "In the shared base", cls: "badge badge--ok" },
  returned: { label: "Returned", cls: "badge badge--danger" },
};

async function call(
  url: string,
  method: "PATCH" | "POST" | "DELETE",
  body?: unknown
): Promise<string | null> {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => null);
  if (!res) return "The server could not be reached.";
  if (!res.ok) {
    const d = await res.json().catch(() => null);
    return d?.message ?? "That did not go through.";
  }
  return null;
}

type Mode = "idle" | "edit" | "delete" | "promote";

export function KnowledgeRow({ row, admin }: { row: MineRow; admin: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    kind: row.kind === "fact" ? "fact" : "choice",
    factKey: row.factKey ?? "",
    category:
      row.kind === "fact" && row.category === "general"
        ? "capability"
        : row.category,
    statement: row.statement,
    detail: row.detail ?? "",
    polarity: row.polarity === "negative" ? "negative" : "affirmative",
  });

  const s = STATUS[row.status] ?? STATUS.private;
  const url = `/api/rfp/knowledge/${row.id}`;
  const frozen = row.status === "approved";

  async function run(fn: () => Promise<string | null>) {
    setBusy(true);
    setError("");
    const err = await fn();
    setBusy(false);
    if (err) return setError(err);
    setMode("idle");
    router.refresh();
  }

  const saveEdit = () =>
    run(() =>
      call(url, "PATCH", {
        kind: form.kind,
        factKey: form.kind === "fact" ? form.factKey : null,
        category: form.kind === "fact" ? form.category : undefined,
        statement: form.statement,
        detail: form.detail,
        polarity: form.polarity,
      })
    );
  const move = (action: "submit" | "withdraw") =>
    run(() => call(url, "POST", { action }));
  const promote = (confidence: "confirmed" | "needs-adam") =>
    run(() => call(url, "POST", { action: "promote", confidence }));
  const remove = () => run(() => call(url, "DELETE"));

  const canSubmit = row.kind === "fact" && !!row.factKey;
  const shown = row.promoted ?? null;
  const factChanged = shown !== null && shown.statement !== row.statement;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <span className={s.cls}>
          {frozen && shown && !shown.live ? "Retired from the shared base" : s.label}
        </span>
        <span className="badge">{row.kind}</span>
        {row.kind === "fact" && row.category !== "general" && (
          <span className="badge">{row.category}</span>
        )}
        {row.polarity === "negative" && <span className="badge">Negative</span>}
        {row.factKey && (
          <span className="mono text-xs text-faint">{row.factKey}</span>
        )}
        <span className="ml-auto text-xs text-faint">
          <When iso={row.createdAt} />
        </span>
      </div>

      {mode !== "edit" && (
        <>
          <p className="mt-2">{row.statement}</p>
          {row.detail && <p className="mt-1 text-sm text-faint">{row.detail}</p>}
          {row.status === "returned" && row.reviewNote && (
            <p className="mt-2 text-sm">
              <span className="text-faint">Returned by {row.reviewedBy}: </span>
              {row.reviewNote}
            </p>
          )}
          {frozen && shown && factChanged && (
            <p className="mt-2 text-sm">
              <span className="text-faint">
                {shown.live ? "Now reads in the shared base: " : "Last read: "}
              </span>
              {shown.statement}
            </p>
          )}
        </>
      )}

      {mode === "edit" && (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap gap-3">
            <select
              className="input"
              value={form.kind}
              onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}
              aria-label="What kind"
            >
              <option value="choice">A decision about one proposal</option>
              <option value="fact">A fact about XL.net</option>
            </select>
            {form.kind === "fact" && (
              <>
                <input
                  className="input mono"
                  value={form.factKey}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, factKey: e.target.value }))
                  }
                  placeholder="support.response-time"
                  aria-label="Fact key"
                />
                <select
                  className="input"
                  value={form.category}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, category: e.target.value }))
                  }
                  aria-label="Category"
                >
                  {KNOWLEDGE_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <select
                  className="input"
                  value={form.polarity}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, polarity: e.target.value }))
                  }
                  aria-label="Is this something XL.net does?"
                >
                  <option value="affirmative">Yes, XL.net does this</option>
                  <option value="negative">No, and that is worth recording</option>
                </select>
              </>
            )}
          </div>
          <textarea
            className="input min-h-20 w-full"
            value={form.statement}
            onChange={(e) =>
              setForm((f) => ({ ...f, statement: e.target.value }))
            }
            aria-label="The statement"
          />
          <input
            className="input w-full"
            value={form.detail}
            onChange={(e) => setForm((f) => ({ ...f, detail: e.target.value }))}
            placeholder="Anything a drafter should know (optional)"
            aria-label="Detail"
          />
          {form.kind === "fact" && row.kind !== "fact" && (
            <p className="text-xs text-faint">
              Turning a one-off decision into a company fact puts it into every
              future proposal once it is approved. Only do this on purpose.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="btn btn--primary"
              disabled={
                busy ||
                form.statement.trim().length < 10 ||
                (form.kind === "fact" && !form.factKey.trim())
              }
              onClick={() => void saveEdit()}
            >
              Save
            </button>
            <button
              type="button"
              className="btn btn--text"
              disabled={busy}
              onClick={() => {
                setError("");
                setMode("idle");
              }}
            >
              Cancel
            </button>
            {error && <span className="badge badge--warn">{error}</span>}
          </div>
        </div>
      )}

      {mode === "delete" && (
        <div className="mt-3 text-sm">
          Gone for good.{" "}
          {row.kind === "fact" && (
            <>Any draft of yours that cites it will ask for that claim again. </>
          )}
          <button
            type="button"
            className="linklike"
            disabled={busy}
            onClick={() => void remove()}
          >
            Delete it
          </button>{" "}
          <button
            type="button"
            className="linklike text-faint"
            disabled={busy}
            onClick={() => {
              setError("");
              setMode("idle");
            }}
          >
            Keep
          </button>
          {error && <span className="badge badge--warn ml-2">{error}</span>}
        </div>
      )}

      {mode === "promote" && (
        <div className="mt-3 space-y-3">
          {row.conflict && (
            <div className="panel panel--lightline-sand">
              <span className="sys-label">Already on file under this key</span>
              <p className="mt-2 text-sm">{row.conflict}</p>
              <p className="mt-2 text-xs text-faint">
                Adding this puts a second fact under the same key. Usually the
                right move is to correct the existing one from the Shared tab.
              </p>
            </div>
          )}
          <p className="text-sm">
            This goes in front of every future proposal, as it reads above.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy}
              onClick={() => void promote("confirmed")}
            >
              Add to the shared base
            </button>
            <button
              type="button"
              className="btn btn--sand"
              disabled={busy}
              onClick={() => void promote("needs-adam")}
            >
              Add as needs confirmation
            </button>
            <button
              type="button"
              className="btn btn--text"
              disabled={busy}
              onClick={() => {
                setError("");
                setMode("idle");
              }}
            >
              Cancel
            </button>
            {error && <span className="badge badge--warn">{error}</span>}
          </div>
        </div>
      )}

      {mode === "idle" && !frozen && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="linklike text-xs"
            disabled={busy}
            onClick={() => setMode("edit")}
          >
            Edit
          </button>
          {row.status === "submitted" ? (
            <button
              type="button"
              className="linklike text-xs"
              disabled={busy}
              onClick={() => void move("withdraw")}
            >
              Withdraw
            </button>
          ) : (
            <button
              type="button"
              className="linklike text-xs"
              disabled={busy || !canSubmit}
              title={
                canSubmit
                  ? undefined
                  : "Only a fact with a key can be sent. Edit it first."
              }
              onClick={() => void move("submit")}
            >
              {row.status === "returned" ? "Send again" : "Send for approval"}
            </button>
          )}
          {admin && (
            <button
              type="button"
              className="linklike text-xs"
              disabled={busy || !canSubmit}
              title={
                canSubmit
                  ? undefined
                  : "Only a fact with a key can go in. Edit it first."
              }
              onClick={() => setMode("promote")}
            >
              Add to the shared base
            </button>
          )}
          <button
            type="button"
            className="linklike text-xs text-faint"
            disabled={busy}
            onClick={() => setMode("delete")}
          >
            Delete
          </button>
          {error && <span className="badge badge--warn">{error}</span>}
        </div>
      )}

      {frozen && (
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
          {admin && shown && shown.live ? (
            <FactActions
              id={shown.id}
              statement={shown.statement}
              detail={shown.detail}
              polarity={shown.polarity}
              category={shown.category}
            />
          ) : (
            <span className="text-faint">
              {shown && !shown.live
                ? "It no longer counts in drafts."
                : "Changes to a shared fact go through an XL.net admin."}
            </span>
          )}
          <Link href="/rfp/knowledge" className="linklike text-xs">
            See the shared base
          </Link>
        </div>
      )}
    </div>
  );
}
