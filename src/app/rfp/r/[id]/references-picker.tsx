"use client";

// The references answer as a form, not a sentence (§5.17.10).
//
// The references question used to take free text that a brain call wove into
// the section; the names, phones and emails came out as prose and were never
// kept. This picker answers the SAME question with structured entries: the
// organizations already on file (GET .../references, ranked for this RFP)
// each behind an Include box, plus typed-in organizations, every one with the
// four card fields the template prints. POST .../references stores them as a
// `references` block on the section (references-block.ts is the one spec the
// screen, Word and PDF draw from) and, when asked, writes the contacts back
// to the shared reference file for the next RFP.
//
// Two modes. "answer" closes the open question. "edit" reopens an answer
// already given: the entries are seeded from the stored block (`initial`)
// and the POST carries `replace: true`, which swaps that section's card set
// in place.
//
// Validation mirrors the contract module's readReferenceEntry per entry
// before the request (and runs it as the final word), so the client refuses
// exactly what the server would and says which field is at fault.
// No page scrolls from here; errors render in this pane; "Skip for now" stays
// with the parent, which owns the queue.

import { useEffect, useId, useState } from "react";
import {
  REFERENCE_LIMITS,
  readReferenceEntry,
  type ReferenceCandidateWire,
  type ReferenceEntry,
  type ReferencesGetResponse,
  type ReferencesPostBody,
  type ReferencesPostResponse,
} from "@/lib/rfp/references-block";

export type ReferencesAnswered = {
  sections: unknown[];
  rev: number;
  labels: string[];
  kept: number;
  created: number;
  note?: string;
};

type Props = {
  proposalId: string;
  /** The question's text as the queue shows it (it names the count asked);
   *  in edit mode, the heading the parent prints. The fieldset's name. */
  question: string;
  /** Every section holding the question; the first one receives the answer.
   *  In edit mode, the one section whose cards are being replaced. */
  targets: { label: string; raw: string }[];
  /** True while a draft run or another write holds the workspace. */
  disabled: boolean;
  onAnswered: (r: ReferencesAnswered) => void;
  /** "answer" (default) closes the open question; "edit" replaces the card
   *  set an earlier answer stored (POST with `replace: true`). */
  mode?: "answer" | "edit";
  /** Edit mode: the stored block's entries, in printed order. */
  initial?: ReferenceEntry[];
  /** How many references the RFP asks for, when the question names it. */
  asked?: number | null;
  /** Answer mode, "Answer in words instead": the parent swaps back to its textarea. */
  onWords?: () => void;
  /** Edit mode, "Cancel": the parent closes the picker, nothing is written. */
  onCancel?: () => void;
};

/** One selected reference as typed. `key` is the candidate id for a row on
 *  file and "new:N" for a typed organization; the wire entry never sees it. */
type Draft = ReferenceEntry & { key: string };

type Field = keyof ReferenceEntry;
/** What the last submit refused about one entry: the fields at fault (only
 *  these carry aria-invalid) and the sentences that say why. */
type Fault = { fields: Set<Field>; messages: string[] };

const ENTRY_INCOMPLETE =
  "Needs an organization, a contact name and a phone or email.";
const EMAIL_MALFORMED = "That email address does not look right.";
const ORGANIZATION_TWICE = "This organization is already included.";
const ENTRY_UNREADABLE =
  "This reference could not be read. Retype its fields.";

// The contract's own email shape (references-block.ts keeps it private);
// readReferenceEntry still has the final word on every entry.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MAX_ENTRIES = REFERENCE_LIMITS.entries[1];

const BLANK: ReferenceEntry = {
  referenceId: null,
  organization: "",
  relevance: "",
  contactName: "",
  contactTitle: "",
  phone: "",
  email: "",
};

function fromCandidate(c: ReferenceCandidateWire): Draft {
  return {
    key: c.id,
    referenceId: c.id,
    organization: c.organization,
    relevance: c.segment,
    contactName: c.contactName ?? "",
    contactTitle: c.contactTitle ?? "",
    phone: c.contactPhone ?? "",
    email: c.contactEmail ?? "",
  };
}

/** Edit mode's starting selection: the stored entries in printed order. An
 *  entry from the reference file keys on its row id (so its Include box
 *  shows ticked once the list loads); a typed one, or a second entry naming
 *  the same row, is a typed entry. */
function seed(initial: ReferenceEntry[]): Draft[] {
  const seen = new Set<string>();
  return initial.slice(0, MAX_ENTRIES).map((e, i) => {
    if (e.referenceId !== null && !seen.has(e.referenceId)) {
      seen.add(e.referenceId);
      return { ...e, key: e.referenceId };
    }
    return { ...e, referenceId: null, key: `new:${i + 1}` };
  });
}

const orgKey = (v: string) => v.trim().replace(/\s+/g, " ").toLowerCase();

/** "2019" from an ISO date or a bare year; the raw text when it is neither. */
function sinceLabel(v: string | null): string | null {
  if (!v) return null;
  const m = /^(\d{4})/.exec(v.trim());
  return m ? m[1] : v.trim();
}

export function ReferencesPicker({
  proposalId,
  question,
  targets,
  disabled,
  onAnswered,
  mode = "answer",
  initial,
  asked = null,
  onWords,
  onCancel,
}: Props) {
  const uid = useId();
  const editing = mode === "edit";
  const [candidates, setCandidates] = useState<ReferenceCandidateWire[]>([]);
  const [loading, setLoading] = useState<"loading" | "ready" | "failed">(
    "loading"
  );
  // Selection order is card order: the first one included is Reference 1.
  const [selected, setSelected] = useState<Draft[]>(() => seed(initial ?? []));
  const [newCount, setNewCount] = useState(() => (initial ?? []).length);
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The server answered 404: the question closed (or the block left the
  // section) in another tab. Only a reload shows what is there now.
  const [stale, setStale] = useState(false);
  // What the last submit refused, per entry; cleared per entry as soon as
  // it is edited again.
  const [faults, setFaults] = useState<Map<string, Fault>>(new Map());

  // The state is born "loading" and the parent keys this picker on the
  // question, so no reset is needed here (and the hooks lint forbids a
  // synchronous set-state in an effect).
  useEffect(() => {
    let cancelled = false;
    // Nothing on file to tick (or the list did not load): start with one
    // blank entry so the first field is already there.
    const startBlank = () =>
      setSelected((prev) =>
        prev.length === 0 ? [{ ...BLANK, key: "new:0" }] : prev
      );
    fetch(`/api/rfp/proposals/${proposalId}/references`, {
      headers: { accept: "application/json" },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const d = (await res.json()) as Partial<ReferencesGetResponse>;
        if (cancelled) return;
        const list = Array.isArray(d.candidates) ? d.candidates : [];
        setCandidates(list);
        setLoading("ready");
        if (list.length === 0) startBlank();
      })
      .catch(() => {
        if (cancelled) return;
        setLoading("failed");
        startBlank();
      });
    return () => {
      cancelled = true;
    };
  }, [proposalId]);

  const isSelected = (key: string) => selected.some((d) => d.key === key);

  // An entry stays linked (and locked) to its organization on file while
  // its row is in the loaded list. Once the list has loaded WITHOUT the row,
  // it is a typed entry: the name becomes editable and no row id is sent.
  // While the list is loading, or when it failed, the link is kept.
  const isLinked = (d: Draft) =>
    d.referenceId !== null &&
    !(loading === "ready" && !candidates.some((c) => c.id === d.referenceId));

  const toEntry = (d: Draft): ReferenceEntry => ({
    referenceId: isLinked(d) ? d.referenceId : null,
    organization: d.organization,
    relevance: d.relevance,
    contactName: d.contactName,
    contactTitle: d.contactTitle,
    phone: d.phone,
    email: d.email,
  });

  function clearFault(key: string) {
    setFaults((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }

  function include(c: ReferenceCandidateWire, on: boolean) {
    setError("");
    if (on) {
      setSelected((prev) =>
        prev.some((d) => d.key === c.id) || prev.length >= MAX_ENTRIES
          ? prev
          : [...prev, fromCandidate(c)]
      );
    } else {
      remove(c.id);
    }
  }

  function remove(key: string) {
    setError("");
    setSelected((prev) => prev.filter((d) => d.key !== key));
    // Removing one can clear another's "already included": drop them all,
    // the next submit says again what still stands.
    setFaults(new Map());
  }

  function addBlank() {
    setError("");
    const key = `new:${newCount + 1}`;
    setNewCount((n) => n + 1);
    setSelected((prev) =>
      prev.length >= MAX_ENTRIES ? prev : [...prev, { ...BLANK, key }]
    );
  }

  function edit(key: string, field: Field, value: string) {
    setSelected((prev) =>
      prev.map((d) => (d.key === key ? { ...d, [field]: value } : d))
    );
    clearFault(key);
    setError("");
  }

  /** Everything wrong with the selection, per entry; empty when it can go. */
  function check(): Map<string, Fault> {
    const out = new Map<string, Fault>();
    const orgs = new Set<string>();
    for (const d of selected) {
      const fields = new Set<Field>();
      const messages: string[] = [];
      const org = orgKey(d.organization);
      const email = d.email.trim();
      const missing: Field[] = [];
      if (!org) missing.push("organization");
      if (!d.contactName.trim()) missing.push("contactName");
      if (!d.phone.trim() && !email) missing.push("phone", "email");
      if (missing.length > 0) {
        for (const f of missing) fields.add(f);
        messages.push(ENTRY_INCOMPLETE);
      }
      if (email && !EMAIL.test(email)) {
        fields.add("email");
        messages.push(EMAIL_MALFORMED);
      }
      if (org) {
        // The same organization twice prints two cards for one client and,
        // kept, would write the file twice.
        if (orgs.has(org)) {
          fields.add("organization");
          messages.push(ORGANIZATION_TWICE);
        }
        orgs.add(org);
      }
      if (messages.length === 0 && !readReferenceEntry(toEntry(d)))
        messages.push(ENTRY_UNREADABLE);
      if (messages.length > 0) out.set(d.key, { fields, messages });
    }
    return out;
  }

  async function submit() {
    if (busy || disabled) return;
    setError("");
    setStale(false);
    if (selected.length === 0) {
      setError(
        editing
          ? "Include at least one reference. To take the cards out, cancel and remove them from the section."
          : "Include at least one reference, or answer in words instead."
      );
      return;
    }
    if (selected.length > MAX_ENTRIES) {
      setError(`At most ${MAX_ENTRIES} references go in one answer.`);
      return;
    }
    const bad = check();
    setFaults(bad);
    if (bad.size > 0) return;
    const references: ReferenceEntry[] = [];
    for (const d of selected) {
      const e = readReferenceEntry(toEntry(d));
      if (e) references.push(e);
    }
    const target = targets[0];
    if (!target || references.length !== selected.length) {
      setError("This question is no longer on a section.");
      return;
    }
    const body: ReferencesPostBody = {
      label: target.label,
      question: editing ? "" : target.raw,
      references,
      keep,
      ...(editing ? { replace: true } : {}),
    };
    setBusy(true);
    const res = await fetch(`/api/rfp/proposals/${proposalId}/references`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    const nothing = editing ? "Nothing was changed." : "Nothing was added.";
    if (!res) {
      setBusy(false);
      setError(`The server could not be reached. ${nothing}`);
      return;
    }
    const d = (await res.json().catch(() => null)) as
      | (Partial<ReferencesPostResponse> & { message?: string; note?: string })
      | null;
    if (!res.ok || !d || !Array.isArray(d.sections)) {
      setBusy(false);
      if (res.status === 404) {
        setStale(true);
        setError(
          (typeof d?.message === "string" && d.message) ||
            (editing
              ? `The references are no longer on this section. ${nothing}`
              : `This question is no longer open. ${nothing}`)
        );
        return;
      }
      setError(
        (typeof d?.message === "string" && d.message) ||
          (editing
            ? "The references could not be saved."
            : "The references could not be added.")
      );
      return;
    }
    // The parent unmounts this picker on success (the question leaves the
    // queue, or edit mode closes), so busy is left set: a second press
    // cannot slip in between.
    onAnswered({
      sections: d.sections,
      rev: typeof d.rev === "number" ? d.rev : 0,
      labels: targets.map((t) => t.label),
      kept: typeof d.kept === "number" ? d.kept : 0,
      created: typeof d.created === "number" ? d.created : 0,
      note: typeof d.note === "string" && d.note ? d.note : undefined,
    });
  }

  const locked = busy || disabled;
  const full = selected.length >= MAX_ENTRIES;

  return (
    <form
      className="mt-4"
      // This form's own checks are the validator: the browser's email
      // tooltip would otherwise block the submit outside this pane.
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {/* The question is the group's name. The pane already prints its text
          above this form, so the legend is for assistive tech only. */}
      <fieldset className="min-w-0 border-0 p-0" disabled={locked}>
        <legend className="sr-only">{question}</legend>

        {loading === "loading" && (
          <p className="text-xs text-faint" role="status" aria-live="polite">
            Loading what is on file
          </p>
        )}
        {loading === "failed" && (
          <p className="text-xs" role="alert">
            The references on file could not be loaded. Add each organization
            below instead.
          </p>
        )}
        {loading === "ready" && candidates.length === 0 && (
          <p className="text-xs text-faint">
            No client references are on file yet. Add each organization below.
          </p>
        )}

        {candidates.length > 0 && (
          <>
            <ul className="grid gap-2" role="list">
              {candidates.map((c) => {
                const on = isSelected(c.id);
                const since = sinceLabel(c.relationshipSince);
                const boxId = `${uid}-inc-${c.id}`;
                return (
                  <li key={c.id} className="min-w-0">
                    <label
                      htmlFor={boxId}
                      className="flex items-start gap-2 text-sm"
                    >
                      <input
                        id={boxId}
                        type="checkbox"
                        className="mt-1"
                        checked={on}
                        // At the limit only a ticked box still answers, so
                        // one can be swapped out.
                        disabled={!on && full}
                        onChange={(e) => include(c, e.target.checked)}
                      />
                      <span className="min-w-0">
                        <span className="sr-only">Include </span>
                        <span className="font-medium">{c.organization}</span>
                        {c.segment && (
                          <span className="text-faint"> · {c.segment}</span>
                        )}
                        {since && (
                          <span className="text-faint">
                            {" "}
                            · client since {since}
                          </span>
                        )}
                        {c.contactName && (
                          <>
                            {" "}
                            <span className="badge">on file</span>
                          </>
                        )}
                        {!c.usableWithoutAsking && (
                          <>
                            {" "}
                            <span className="badge">Ask the client first</span>
                          </>
                        )}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
            <p className="mt-2 text-xs text-faint">
              These contacts are printed in the proposal. Confirm each client
              has agreed to be a reference.
            </p>
          </>
        )}

        {/* ONE list, in selection order: Reference N here is card N in the
            proposal, whether it came from the file or was typed. */}
        {selected.length > 0 && (
          <ol className="mt-3 grid list-none gap-3 p-0" role="list">
            {selected.map((d, i) => (
              <li key={d.key} className="min-w-0">
                <EntryFields
                  uid={uid}
                  draft={d}
                  n={i + 1}
                  organizationEditable={!isLinked(d)}
                  fault={faults.get(d.key) ?? null}
                  onEdit={edit}
                  onRemove={remove}
                />
              </li>
            ))}
          </ol>
        )}

        <button
          type="button"
          className="btn btn--text mt-3"
          onClick={addBlank}
          disabled={locked || full}
        >
          {selected.length === 0
            ? "Add an organization"
            : "Add another organization"}
        </button>

        <p className="mt-3 text-xs text-faint" role="status" aria-live="polite">
          {selected.length} included
          {full ? ` · ${MAX_ENTRIES} is the most one answer holds` : ""}
        </p>
        {asked !== null && (
          <p className="mt-1 text-xs text-faint">The RFP asks for {asked}.</p>
        )}
        {asked !== null && selected.length > 0 && selected.length < asked && (
          <p className="mt-1 text-xs">
            That is fewer than the RFP asks for. You can still add these and
            come back for the rest.
          </p>
        )}

        <label className="mt-3 flex items-start gap-2 text-xs text-faint">
          <input
            type="checkbox"
            checked={keep}
            onChange={(e) => setKeep(e.target.checked)}
          />
          <span>
            Save these contacts to the shared reference file · every RFP staff
            member sees them, and edits here replace what is on file
          </span>
        </label>

        {error && (
          <div className="mt-3" role="alert">
            <p className="text-xs">{error}</p>
            {stale && (
              <button
                type="button"
                className="btn mt-2"
                onClick={() => window.location.reload()}
              >
                Reload
              </button>
            )}
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="submit"
            className="btn btn--primary"
            disabled={locked}
            aria-busy={busy ? true : undefined}
          >
            {editing ? "Save references" : "Add references"}
          </button>
          {editing
            ? onCancel && (
                <button
                  type="button"
                  className="btn btn--text"
                  onClick={onCancel}
                  disabled={busy}
                >
                  Cancel
                </button>
              )
            : onWords && (
                <button
                  type="button"
                  className="btn btn--text"
                  onClick={onWords}
                  disabled={locked}
                >
                  Answer in words instead
                </button>
              )}
        </div>
      </fieldset>
    </form>
  );
}

/**
 * The card fields of one selected reference, numbered in selection order.
 * Organization is editable only on a typed entry: a row on file shows its
 * name as text, so `referenceId` still points at the organization it names.
 */
function EntryFields({
  uid,
  draft,
  n,
  organizationEditable,
  fault,
  onEdit,
  onRemove,
}: {
  uid: string;
  draft: Draft;
  n: number;
  organizationEditable: boolean;
  fault: Fault | null;
  onEdit: (key: string, field: Field, value: string) => void;
  onRemove: (key: string) => void;
}) {
  const id = (f: string) => `${uid}-${draft.key}-${f}`;
  const msgId = id("msg");
  const field = (
    f: Field,
    label: string,
    opts: { max: number; type?: string; mode?: "tel" | "email" }
  ) => {
    const bad = fault !== null && fault.fields.has(f);
    return (
      <div className="min-w-0">
        <label htmlFor={id(f)} className="block text-xs text-faint">
          {label}
        </label>
        <input
          id={id(f)}
          className="input mt-1 w-full"
          type={opts.type ?? "text"}
          inputMode={opts.mode}
          autoComplete="off"
          maxLength={opts.max}
          value={draft[f] ?? ""}
          onChange={(e) => onEdit(draft.key, f, e.target.value)}
          aria-invalid={bad ? true : undefined}
          aria-describedby={bad ? msgId : undefined}
        />
      </div>
    );
  };
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <div className="flex items-baseline justify-between gap-2 sm:col-span-2">
        <span className="min-w-0">
          <span className="sys-label">Reference {n}</span>
          {!organizationEditable && (
            <span className="text-sm font-medium"> · {draft.organization}</span>
          )}
        </span>
        <button
          type="button"
          className="btn btn--text"
          onClick={() => onRemove(draft.key)}
          aria-label={`Remove reference ${n}${draft.organization ? `, ${draft.organization}` : ""}`}
        >
          Remove
        </button>
      </div>
      {organizationEditable ? (
        <div className="sm:col-span-2">
          {field("organization", "Organization", {
            max: REFERENCE_LIMITS.organization,
          })}
        </div>
      ) : null}
      <div className="sm:col-span-2">
        {field("relevance", "Industry / relevance", {
          max: REFERENCE_LIMITS.relevance,
        })}
      </div>
      {field("contactName", "Contact name", {
        max: REFERENCE_LIMITS.contactName,
      })}
      {field("contactTitle", "Title", { max: REFERENCE_LIMITS.contactTitle })}
      {field("phone", "Phone", {
        max: REFERENCE_LIMITS.phone,
        type: "tel",
        mode: "tel",
      })}
      {field("email", "Email", {
        max: REFERENCE_LIMITS.email,
        type: "email",
        mode: "email",
      })}
      {fault && (
        <p id={msgId} className="text-xs sm:col-span-2" role="alert">
          {fault.messages.join(" ")}
        </p>
      )}
    </div>
  );
}
