"use client";

// Admin editing on /rfp/knowledge (§5.17.2 round 5). Inline, per row, in the
// section's own visual language. Corrections go through the correction
// machinery (new row at a new KB version, old row retired) — never an edit
// in place — so everything the corrected-facts page and rule C1 promise
// stays true for changes made here.

import { useState } from "react";
import { useRouter } from "next/navigation";

async function post(
  url: string,
  body: unknown,
  method: "POST" | "PATCH" = "POST"
): Promise<string | null> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => null);
  if (!res) return "The server could not be reached.";
  if (!res.ok) {
    const d = await res.json().catch(() => null);
    return d?.message ?? "That did not go through.";
  }
  return null;
}

const CATEGORIES = [
  "firmography",
  "capability",
  "compliance",
  "commercial",
  "operations",
  "tooling",
];

export function FactActions({
  id,
  statement,
  detail,
  polarity,
  category,
}: {
  id: string;
  statement: string;
  detail: string | null;
  polarity: string;
  category: string;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"idle" | "correct" | "retire">("idle");
  const [form, setForm] = useState({
    statement,
    detail: detail ?? "",
    polarity,
    category,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submitCorrection() {
    setBusy(true);
    setError("");
    const err = await post(`/api/rfp/knowledge/facts/${id}`, {
      action: "correct",
      statement: form.statement,
      detail: form.detail || undefined,
      polarity: form.polarity,
      category: form.category,
    });
    setBusy(false);
    if (err) return setError(err);
    setMode("idle");
    router.refresh();
  }

  async function submitRetire() {
    setBusy(true);
    setError("");
    const err = await post(`/api/rfp/knowledge/facts/${id}`, {
      action: "retire",
    });
    setBusy(false);
    if (err) return setError(err);
    setMode("idle");
    router.refresh();
  }

  if (mode === "idle")
    return (
      <span className="inline-flex gap-3">
        <button
          type="button"
          className="linklike text-xs"
          onClick={() => setMode("correct")}
        >
          Correct
        </button>
        <button
          type="button"
          className="linklike text-xs text-faint"
          onClick={() => setMode("retire")}
        >
          Retire
        </button>
      </span>
    );

  if (mode === "retire")
    return (
      <span className="text-xs">
        Stops being citable; kept for history.{" "}
        <button
          type="button"
          className="linklike"
          disabled={busy}
          onClick={() => void submitRetire()}
        >
          Retire it
        </button>{" "}
        <button
          type="button"
          className="linklike text-faint"
          onClick={() => setMode("idle")}
        >
          Keep
        </button>
        {error && <span className="badge badge--warn ml-2">{error}</span>}
      </span>
    );

  return (
    <div className="mt-2 space-y-2">
      <textarea
        className="input min-h-20 w-full"
        value={form.statement}
        onChange={(e) => setForm((f) => ({ ...f, statement: e.target.value }))}
        aria-label="Corrected statement"
      />
      <input
        className="input w-full"
        value={form.detail}
        onChange={(e) => setForm((f) => ({ ...f, detail: e.target.value }))}
        placeholder="Detail (optional)"
        aria-label="Detail"
      />
      <div className="flex flex-wrap gap-3">
        <select
          className="input"
          value={form.category}
          onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
          aria-label="Category"
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select
          className="input"
          value={form.polarity}
          onChange={(e) => setForm((f) => ({ ...f, polarity: e.target.value }))}
          aria-label="Polarity"
        >
          <option value="affirmative">affirmative</option>
          <option value="negative">negative</option>
        </select>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy || form.statement.trim().length < 5}
          onClick={() => void submitCorrection()}
        >
          {busy ? "Saving" : "Save as a correction"}
        </button>
        <button
          type="button"
          className="btn btn--text"
          onClick={() => setMode("idle")}
        >
          Cancel
        </button>
        {error && <span className="badge badge--warn text-xs">{error}</span>}
      </div>
      <p className="text-xs text-faint">
        Saved as a new version at a new KB number; the old wording is retired,
        not erased, and drafts citing it become findable as stale.
      </p>
    </div>
  );
}

export function AddFact() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    key: "",
    statement: "",
    detail: "",
    category: "capability",
    polarity: "affirmative",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setBusy(true);
    setError("");
    const err = await post(`/api/rfp/knowledge/facts`, {
      ...form,
      detail: form.detail || undefined,
    });
    setBusy(false);
    if (err) return setError(err);
    setOpen(false);
    setForm({
      key: "",
      statement: "",
      detail: "",
      category: "capability",
      polarity: "affirmative",
    });
    router.refresh();
  }

  if (!open)
    return (
      <button
        type="button"
        className="btn btn--text"
        onClick={() => setOpen(true)}
      >
        Add a fact
      </button>
    );

  return (
    <div className="panel mt-4 space-y-3">
      <span className="sys-label">New fact</span>
      <input
        className="input w-full"
        value={form.key}
        onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))}
        placeholder="key, like contract.term"
        aria-label="Fact key"
      />
      <textarea
        className="input min-h-20 w-full"
        value={form.statement}
        onChange={(e) => setForm((f) => ({ ...f, statement: e.target.value }))}
        placeholder="The canonical statement, as a proposal should assert it."
        aria-label="Statement"
      />
      <input
        className="input w-full"
        value={form.detail}
        onChange={(e) => setForm((f) => ({ ...f, detail: e.target.value }))}
        placeholder="Detail a drafter needs (optional)"
        aria-label="Detail"
      />
      <div className="flex flex-wrap gap-3">
        <select
          className="input"
          value={form.category}
          onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
          aria-label="Category"
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select
          className="input"
          value={form.polarity}
          onChange={(e) => setForm((f) => ({ ...f, polarity: e.target.value }))}
          aria-label="Polarity"
        >
          <option value="affirmative">affirmative</option>
          <option value="negative">negative</option>
        </select>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy || form.statement.trim().length < 5 || !form.key.trim()}
          onClick={() => void submit()}
        >
          {busy ? "Saving" : "Add it"}
        </button>
        <button
          type="button"
          className="btn btn--text"
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
        {error && <span className="badge badge--warn text-xs">{error}</span>}
      </div>
    </div>
  );
}

export function RatePrice({
  code,
  cents,
  computed,
}: {
  code: string;
  cents: number;
  /** A zero-priced line whose figure the engine derives; not editable. */
  computed: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState((cents / 100).toFixed(2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (computed) return <span className="text-faint text-xs">computed</span>;
  if (!editing)
    return (
      <button
        type="button"
        className="linklike text-xs"
        onClick={() => setEditing(true)}
      >
        Edit
      </button>
    );
  return (
    <span className="inline-flex items-center gap-2">
      <input
        className="input w-24"
        inputMode="decimal"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label={`New price for ${code}`}
      />
      <button
        type="button"
        className="linklike text-xs"
        disabled={busy}
        onClick={async () => {
          const dollars = Number(value);
          if (!Number.isFinite(dollars) || dollars < 0) {
            setError("A number, in dollars.");
            return;
          }
          setBusy(true);
          setError("");
          const err = await post(
            "/api/rfp/ratecard",
            { code, unitPriceCents: Math.round(dollars * 100) },
            "PATCH"
          );
          setBusy(false);
          if (err) return setError(err);
          setEditing(false);
          router.refresh();
        }}
      >
        Save
      </button>
      <button
        type="button"
        className="linklike text-xs text-faint"
        onClick={() => setEditing(false)}
      >
        Cancel
      </button>
      {error && <span className="badge badge--warn text-xs">{error}</span>}
    </span>
  );
}

export function QuestionEdit({
  id,
  text,
  required,
}: {
  id: string;
  text: string;
  required: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ text, required });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!editing)
    return (
      <button
        type="button"
        className="linklike text-xs"
        onClick={() => setEditing(true)}
      >
        Edit
      </button>
    );
  return (
    <div className="mt-2 space-y-2">
      <textarea
        className="input min-h-16 w-full"
        value={form.text}
        onChange={(e) => setForm((f) => ({ ...f, text: e.target.value }))}
        aria-label="Question text"
      />
      <label className="flex items-center gap-2 text-xs text-faint">
        <input
          type="checkbox"
          checked={form.required}
          onChange={(e) =>
            setForm((f) => ({ ...f, required: e.target.checked }))
          }
        />
        Required
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy || form.text.trim().length < 5}
          onClick={async () => {
            setBusy(true);
            setError("");
            const err = await post(`/api/rfp/questions/${id}`, form, "PATCH");
            setBusy(false);
            if (err) return setError(err);
            setEditing(false);
            router.refresh();
          }}
        >
          {busy ? "Saving" : "Save"}
        </button>
        <button
          type="button"
          className="btn btn--text"
          onClick={() => setEditing(false)}
        >
          Cancel
        </button>
        {error && <span className="badge badge--warn text-xs">{error}</span>}
      </div>
    </div>
  );
}


export function MinimumsEdit({
  minimumFullyManagedUsers,
  minimumMonthlyFeeCents,
}: {
  minimumFullyManagedUsers: number;
  minimumMonthlyFeeCents: number;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [users, setUsers] = useState(String(minimumFullyManagedUsers));
  const [floor, setFloor] = useState((minimumMonthlyFeeCents / 100).toFixed(2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!editing)
    return (
      <button
        type="button"
        className="linklike text-xs"
        onClick={() => setEditing(true)}
      >
        Edit minimums
      </button>
    );
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <label className="text-xs text-faint">
        Users{" "}
        <input
          className="input w-16"
          inputMode="numeric"
          value={users}
          onChange={(e) => setUsers(e.target.value)}
        />
      </label>
      <label className="text-xs text-faint">
        Floor ${" "}
        <input
          className="input w-24"
          inputMode="decimal"
          value={floor}
          onChange={(e) => setFloor(e.target.value)}
        />
      </label>
      <button
        type="button"
        className="linklike text-xs"
        disabled={busy}
        onClick={async () => {
          const u = Number(users);
          const f = Number(floor);
          if (!Number.isFinite(u) || !Number.isFinite(f) || u < 0 || f < 0) {
            setError("Numbers only.");
            return;
          }
          setBusy(true);
          setError("");
          const err = await post(
            "/api/rfp/ratecard",
            {
              minimumFullyManagedUsers: Math.floor(u),
              minimumMonthlyFeeCents: Math.round(f * 100),
            },
            "PATCH"
          );
          setBusy(false);
          if (err) return setError(err);
          setEditing(false);
          router.refresh();
        }}
      >
        Save
      </button>
      <button
        type="button"
        className="linklike text-xs text-faint"
        onClick={() => setEditing(false)}
      >
        Cancel
      </button>
      {error && <span className="badge badge--warn text-xs">{error}</span>}
    </span>
  );
}
