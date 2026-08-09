"use client";

// Directory table island (§5.18 step 2). The server page fetches the rows
// with the principal's company id and hydrates this island; every mutation
// posts to the API and then router.refresh(), so the rendered rows are
// always the server's. Members get the same table read-only. Removal is
// two-click, with the suppression checkbox defaulting ON for Apollo-sourced
// rows so a removed person is not resurrected by the next import.
//
// Round 3 auto-init parity: when the server says autoInit (admin + zero
// people + never imported + active + Apollo configured), this island kicks
// ONE {trigger:"auto"} import through the same runImport path and busy UI,
// fenced by the SAME sessionStorage key the hub card uses
// (apolloKickGuardKey), so hub -> step navigation cannot double-kick.
// Auto-lane failures degrade SILENTLY to the normal manual state; the
// Import button stays the retry lever.
//
// BULK-CLEANUP ROUND (2026-08-09, owner report: the 61st removal in an hour
// answered "Too many requests. Give it a moment." for ten minutes):
//  - PAGER. 10/50/250, no All (the owner's ruling: an editable row per
//    person makes All too much). The shared usePagedList windows CLIENT-side
//    over rows the server already truncated at directoryRenderMax; `total`
//    is the real row count, and the truncation note is what stops a
//    truncated list from being silent.
//  - SELECTION + BULK REMOVE. A Set of ids that PERSISTS across page and
//    page-size changes (a sweep that resets every ten rows is not a sweep)
//    but is CLEARED after any successful mutation, because the ids may no
//    longer exist. The header checkbox is "this page only" on purpose: a
//    control that selects rows the admin has not looked at is how 500 people
//    get deleted by accident. The confirm step LISTS the names, because a
//    selection assembled four pages ago is otherwise unauditable.
//  - COOLDOWN. A 429 now carries retryAfterSec, so the island knows when the
//    controls come back, says so in wall-clock terms, and marks the write
//    controls aria-disabled (never `disabled`, which would blur the focus of
//    the very button that was just pressed). The armed row also says it
//    locally: the owner was deep in a 500-row list, where a sentence painted
//    above the table is invisible and a still-clickable button reads as
//    "nothing happened, click again".
//  - PER-ROW state. rowErr and rowBusy used to be one shared string and one
//    shared boolean, so a failure reported itself thousands of pixels from
//    the row that caused it and one save greyed every row's buttons.
//
// SCROLL-JUMP FIX (2026-08-09, owner report: "when removing a user from the
// directory it scrolls all the way up afterwards, and it should not"): the
// focus rescue moves focus with preventScroll, and the outcome line now
// renders above AND below the table so the rescue can land on the copy the
// admin can already see (BulkBar's rule, for BulkBar's reason). Only the top
// copy is the live region. The reasoning is at the effect itself, next to
// the guard it corrects.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ROADMAP_CAPS, apolloKickGuardKey } from "@/lib/roadmap/config";
import { importLine, type ImportResult } from "@/lib/roadmap/apollo-copy";
import { PagerStrip, usePagedList } from "@/components/list-pager";

export type DirectoryPerson = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  source: string;
};

type ApiError = { error?: { code?: string; message?: string } };
type RateLimited = { error?: { retryAfterSec?: number } };

const inputCls =
  "w-full rounded-lg border bg-transparent px-2 py-1 text-sm";
const inputStyle = { borderColor: "var(--xl-line)" } as const;

/** Module-level so the options object is referentially stable across
 * renders (usePagedList reads sizes every render). 10 first: the first entry
 * is the size the list opens on. No 0/All entry, by owner ruling. */
const DIRECTORY_PAGER = {
  sizes: [10, 50, 250],
  plural: "people",
} as const;

export function DirectoryTable({
  people,
  total,
  isAdmin,
  domain,
  autoInit,
  visibilityNote,
  memberEmptyLine,
}: {
  people: DirectoryPerson[];
  /** Real row count for the lane. Larger than people.length means the server
   * truncated at directoryRenderMax and the extra rows are unreachable, so
   * the table has to say so. */
  total: number;
  isAdmin: boolean;
  domain: string;
  autoInit: boolean;
  /** Staff lane (§5.18 staff parity): overrides the import-panel
   * visibility sentence (the company default would render the redundant
   * "...at xl.net..., and to XL.net"). */
  visibilityNote?: string;
  /** Staff lane: overrides the member zero-state's "Your company admin
   * adds people here." (the staff lane has no company admin). */
  memberEmptyLine?: string;
}) {
  const router = useRouter();
  const [importBusy, setImportBusy] = useState(false);
  const [importNote, setImportNote] = useState<string | null>(null);
  const [importErr, setImportErr] = useState<string | null>(null);
  const [add, setAdd] = useState({ name: "", email: "", phone: "" });
  const [addBusy, setAddBusy] = useState(false);
  const [addErr, setAddErr] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [edit, setEdit] = useState({ name: "", email: "", phone: "" });
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [suppress, setSuppress] = useState(false);
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);
  const [rowErr, setRowErr] = useState<{ id: string; message: string } | null>(
    null
  );
  const [done, setDone] = useState<string | null>(null);
  // Selection survives paging; it is cleared on every successful mutation.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkArmed, setBulkArmed] = useState(false);
  const [bulkSuppress, setBulkSuppress] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkErr, setBulkErr] = useState<string | null>(null);
  // When directory writes are allowed again, and WHICH bucket refused. The
  // two limiter keys are independent, so a banner that always quoted the
  // single-write cap would state a number the refusal did not come from and
  // (worse) advise "use Remove selected" when Remove selected is the thing
  // that is exhausted.
  const [cooldown, setCooldown] = useState<{
    until: number;
    lane: "single" | "bulk";
  } | null>(null);
  // The outcome line renders at BOTH ends of the table, for the same reason
  // BulkBar does, so the focus rescue has a copy near wherever the admin is
  // standing. The bottom copy exists only alongside the rows.
  const doneTopRef = useRef<HTMLParagraphElement | null>(null);
  const doneBottomRef = useRef<HTMLParagraphElement | null>(null);

  const pager = usePagedList(people, "person", DIRECTORY_PAGER);
  // DERIVED from the rendered rows, never the raw Set: for one tick after a
  // removal the Set still holds dead ids, and a count shown to a human must
  // never be able to disagree with the list beside it.
  const selectedPeople = people.filter((p) => selected.has(p.id));
  // Only the bucket that actually refused is inert: a bulk refusal must not
  // block the single-row Remove the admin would reach for instead.
  const singleCooling = cooldown?.lane === "single";
  const bulkCooling = cooldown?.lane === "bulk";

  function clearRowState() {
    setEditId(null);
    setRemoveId(null);
  }

  /** Any page or size change disarms the row controls: an armed confirm
   * strip or an open edit form on a row that just left the viewport is a
   * mis-click (or a silent discard of typed values) waiting to happen.
   * rowErr deliberately SURVIVES: it is the only report of what just failed.
   * Selection deliberately survives too: it is the point of the feature.
   *
   * Both wrappers repeat the pager's own no-op guard BEFORE clearing. The
   * arrows stay mounted and inert via aria-disabled, so Prev on page 1 is a
   * live click that reaches this handler; clearing first would let a button
   * that visibly does nothing silently discard an open inline edit. */
  function pagedGoTo(n: number) {
    if (n < 0 || n >= pager.pageCount || n === pager.safePage) return;
    clearRowState();
    pager.goTo(n);
  }
  function pagedChangeSize(n: number) {
    if (n === pager.pageSize) return;
    clearRowState();
    pager.changeSize(n);
  }
  const pagerNav = { ...pager, goTo: pagedGoTo, changeSize: pagedChangeSize };

  /** One place decides what a failed response says, and whether it starts a
   * cooldown. `lane` is which limiter bucket the call drew from, so the
   * banner can quote the cap that actually refused. Returns the message so
   * callers can place it themselves. */
  async function readError(
    res: Response,
    lane: "single" | "bulk"
  ): Promise<string> {
    const data = (await res.json().catch(() => null)) as
      | (ApiError & RateLimited)
      | null;
    if (res.status === 429) {
      const sec = data?.error?.retryAfterSec;
      // Fall back to the enforced window, never to zero: a cooldown that
      // clears immediately would put the same wall back in front of the
      // next click with no explanation.
      setCooldown({
        until:
          Date.now() +
          (typeof sec === "number" && sec > 0 ? sec : 60) * 1000,
        lane,
      });
    }
    return data?.error?.message ?? "Something went wrong. Try again shortly.";
  }

  // The controls come back on their own. One timer, re-armed only when the
  // deadline changes, so nothing re-renders on a tick.
  const cooldownUntil = cooldown?.until ?? null;
  useEffect(() => {
    if (cooldownUntil === null) return;
    // Always through the timer, never a synchronous setState in the effect
    // body (cascading renders): a deadline already past just clears on the
    // next tick.
    const t = window.setTimeout(
      () => setCooldown(null),
      Math.max(0, cooldownUntil - Date.now())
    );
    return () => window.clearTimeout(t);
  }, [cooldownUntil]);

  // A successful removal unmounts the control that was just pressed, which
  // drops keyboard focus to <body>. Rescue it onto the outcome line, but
  // ONLY when it was actually orphaned, so a mouse user is never yanked out
  // of whatever they moved to next.
  //
  // NEAREST COPY, NO SCROLL (2026-08-09, owner report: "when removing a user
  // from the directory it scrolls all the way up afterwards, and it should
  // not"). Two things made that a full glide to the top: the outcome line
  // rendered ONLY above the table, and futurism.css sets `scroll-behavior:
  // smooth` on html, so a bare focus() animated the whole viewport up there.
  // The orphan guard does not spare the mouse either: a click focuses the
  // button it lands on, so Confirm remove (and the bulk bar, which unmounts
  // whole once the selection empties) leaves activeElement on <body> for a
  // mouse user too, and the guard passes.
  //
  // What this buys, stated honestly. preventScroll alone would have moved
  // focus to something the admin cannot see, which is why BOTH prior uses in
  // this repo (work/pager.tsx, governance/home.tsx) pair it with a scroll
  // they perform themselves. The second copy of the line is this file's
  // version of that: after a sweep launched from the bottom bulk bar, or an
  // edit near either end, the rescue lands on a copy that is already on
  // screen and the outcome is read where it happened. It is NOT a guarantee
  // for every case: remove one person from the middle of a 250-row page and
  // neither copy is in view, so focus moves silently. What still holds there
  // is that the top copy is role="status" and announces regardless, the
  // failure path reports at the row instead, and the next Tab scrolls
  // normally (sequential focus navigation always scrolls). An unseen focus
  // ring beats hauling a 500-row list back to the top on every removal.
  useEffect(() => {
    if (!done) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    nearerToViewport(doneTopRef.current, doneBottomRef.current)?.focus({
      preventScroll: true,
    });
  }, [done]);

  function afterMutation(message: string, clearSelection = false) {
    // Only a bulk sweep consumed the whole selection. An Add or a Save
    // invalidates no selected id, and a single removal drops out on its own
    // because selectedPeople is DERIVED from the rendered rows: clearing
    // here would silently discard multi-page selection work.
    if (clearSelection) setSelected(new Set());
    setBulkArmed(false);
    setDone(message);
    router.refresh();
  }

  async function runImport(trigger: "manual" | "auto" = "manual") {
    setImportBusy(true);
    setImportNote(null);
    setImportErr(null);
    try {
      const res = await fetch(
        "/api/roadmap/apollo-import",
        trigger === "auto"
          ? {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ trigger: "auto" }),
            }
          : { method: "POST" }
      );
      if (!res.ok) {
        // Auto lane: 429/403/503 and friends degrade SILENTLY to the normal
        // manual state (no error banner); the button is the retry lever.
        // The import limiter is per-company and hourly, a different bucket
        // from the directory write cooldown, so its 429 must NOT paint the
        // "directory changes are paused" banner.
        const data = (await res.json().catch(() => null)) as ApiError | null;
        if (trigger === "manual")
          setImportErr(
            data?.error?.message ?? "Something went wrong. Try again shortly."
          );
        return;
      }
      const data = (await res.json().catch(() => null)) as ImportResult | null;
      setImportNote(
        importLine(data ?? {}, domain, "Add people manually below.")
      );
      setSelected(new Set());
      setBulkArmed(false);
      router.refresh();
    } catch {
      if (trigger === "manual")
        setImportErr(
          "Something went wrong. Check your connection and try again."
        );
    } finally {
      setImportBusy(false);
    }
  }

  // The auto-kick (round 3): once per mount (StrictMode ref guard), fenced
  // by the shared per-domain sessionStorage key, pre-set synchronously
  // BEFORE the POST so a concurrent surface cannot kick again.
  const autoRan = useRef(false);
  useEffect(() => {
    if (!autoInit || autoRan.current) return;
    autoRan.current = true;
    try {
      const key = apolloKickGuardKey(domain);
      if (window.sessionStorage.getItem(key) !== null) return;
      window.sessionStorage.setItem(key, String(Date.now()));
    } catch {
      // No sessionStorage means no reload fence: do not kick.
      return;
    }
    // Deferred a tick (codebase pattern: open-items-resolver) so the effect
    // body stays setState-free; the guard above already ran synchronously.
    // No cleanup cancel: StrictMode's immediate unmount would eat the only
    // kick (the ref guard blocks the remount's attempt).
    window.setTimeout(() => void runImport("auto"), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoInit, domain]);

  async function addPerson(e: React.FormEvent) {
    e.preventDefault();
    if (singleCooling || addBusy) return;
    setAddBusy(true);
    setAddErr(null);
    setDone(null);
    try {
      const res = await fetch("/api/roadmap/directory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: add.name,
          email: add.email || null,
          phone: add.phone || null,
        }),
      });
      if (!res.ok) {
        setAddErr(await readError(res, "single"));
        return;
      }
      const named = add.name.trim();
      setAdd({ name: "", email: "", phone: "" });
      afterMutation(`Added ${named}.`);
    } catch {
      setAddErr("Something went wrong. Check your connection and try again.");
    } finally {
      setAddBusy(false);
    }
  }

  function startEdit(p: DirectoryPerson) {
    setEditId(p.id);
    setRemoveId(null);
    setRowErr(null);
    setDone(null);
    setEdit({ name: p.name, email: p.email ?? "", phone: p.phone ?? "" });
  }

  async function saveEdit(id: string) {
    if (singleCooling || rowBusyId !== null) return;
    setRowBusyId(id);
    setRowErr(null);
    try {
      const res = await fetch(`/api/roadmap/directory/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: edit.name,
          email: edit.email || null,
          phone: edit.phone || null,
        }),
      });
      if (!res.ok) {
        setRowErr({ id, message: await readError(res, "single") });
        return;
      }
      const named = edit.name.trim();
      setEditId(null);
      afterMutation(`Saved ${named}.`);
    } catch {
      setRowErr({
        id,
        message: "Something went wrong. Check your connection and try again.",
      });
    } finally {
      setRowBusyId(null);
    }
  }

  function armRemove(p: DirectoryPerson) {
    setRemoveId(p.id);
    setEditId(null);
    setRowErr(null);
    setDone(null);
    setSuppress(p.source === "apollo");
  }

  async function confirmRemove(p: DirectoryPerson) {
    if (singleCooling || rowBusyId !== null) return;
    setRowBusyId(p.id);
    setRowErr(null);
    try {
      const res = await fetch(
        `/api/roadmap/directory/${p.id}${suppress ? "" : "?suppress=0"}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        setRowErr({ id: p.id, message: await readError(res, "single") });
        return;
      }
      setRemoveId(null);
      afterMutation(`Removed ${p.name}.`);
    } catch {
      setRowErr({
        id: p.id,
        message: "Something went wrong. Check your connection and try again.",
      });
    } finally {
      setRowBusyId(null);
    }
  }

  function toggleOne(id: string, on: boolean) {
    setDone(null);
    setBulkArmed(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  const pageIds = pager.windowed.map((p) => p.id);
  const pageSelected = pageIds.filter((id) => selected.has(id)).length;
  const allOnPage = pageIds.length > 0 && pageSelected === pageIds.length;

  function togglePage(on: boolean) {
    setDone(null);
    setBulkArmed(false);
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of pageIds) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  function armBulk() {
    setBulkErr(null);
    setDone(null);
    // EVERY, not some. Suppression is irreversible from the UI and stores a
    // one-way hash, so a mixed selection must not blacklist the hand-added
    // people as a side effect of the Apollo ones. When every row came from
    // Apollo the intent is unambiguous and the flag is what stops the next
    // import resurrecting them.
    setBulkSuppress(
      selectedPeople.length > 0 &&
        selectedPeople.every((p) => p.source === "apollo")
    );
    setBulkArmed(true);
  }

  /** CHUNKED, because a selection can legitimately be larger than one
   * request: the page size goes to 250 and selection survives paging, while
   * the route caps ids at directoryBulkRemoveMax. Sending the whole set
   * would dead-end "select all on this page" at 250 with a 400 nobody can
   * act on. Chunks run in sequence so a mid-sweep refusal leaves a coherent
   * state: what already went through is gone, the untouched remainder stays
   * SELECTED, and the message says how far it got. */
  async function confirmBulk() {
    if (bulkCooling || bulkBusy) return;
    const ids = selectedPeople.map((p) => p.id);
    if (ids.length === 0) return;
    const chunk = ROADMAP_CAPS.directoryBulkRemoveMax;
    setBulkBusy(true);
    setBulkErr(null);
    let removed = 0;
    let suppressed = 0;
    try {
      for (let i = 0; i < ids.length; i += chunk) {
        const slice = ids.slice(i, i + chunk);
        const res = await fetch("/api/roadmap/directory/remove", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids: slice, suppress: bulkSuppress }),
        });
        if (!res.ok) {
          const message = await readError(res, "bulk");
          setSelected(new Set(ids.slice(i)));
          setBulkArmed(false);
          setBulkErr(
            removed > 0
              ? `Removed ${removed} of ${ids.length}, then stopped. ${message}`
              : message
          );
          if (removed > 0) router.refresh();
          return;
        }
        const data = (await res.json().catch(() => null)) as {
          removed?: number;
          suppressed?: number;
        } | null;
        removed += data?.removed ?? slice.length;
        suppressed += data?.suppressed ?? 0;
      }
      const head =
        removed === ids.length
          ? `Removed ${removed} ${removed === 1 ? "person" : "people"}.`
          : `Removed ${removed} of ${ids.length}. The rest were already gone.`;
      // Suppression is the half that does not undo itself, so it is said out
      // loud rather than left in a response field nobody renders.
      afterMutation(
        suppressed > 0
          ? `${head} ${suppressed} of them will be skipped by future imports.`
          : head,
        true
      );
    } catch {
      if (removed > 0) router.refresh();
      setBulkErr("Something went wrong. Check your connection and try again.");
    } finally {
      setBulkBusy(false);
    }
  }

  const cooldownClock =
    cooldownUntil === null
      ? ""
      : new Date(cooldownUntil).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
          // Seconds included deliberately: both windows are 60 seconds, so
          // minute granularity would routinely name a minute that has
          // already begun, or already passed while the controls are inert.
          second: "2-digit",
        });
  const pausedClause = `Paused until ${cooldownClock}.`;
  const singlePaused = singleCooling ? pausedClause : null;
  const bulkPaused = bulkCooling ? pausedClause : null;

  const hiddenSelected = selectedPeople.length - pageSelected;
  const bulkCount = selectedPeople.length;

  return (
    <div className="space-y-8">
      {cooldown !== null && (
        <div className="panel" role="alert">
          <span className="sys-label">Paused</span>
          <p className="mt-3 text-sm font-medium">
            {singleCooling
              ? `One-at-a-time changes are paused until ${cooldownClock}.`
              : `Remove selected is paused until ${cooldownClock}.`}
          </p>
          <p className="mt-2 text-sm">
            {singleCooling
              ? `That is ${ROADMAP_CAPS.directoryWritesPerUserPerMinute} changes in a minute, which is the cap.`
              : `That is ${ROADMAP_CAPS.directoryBulkRemovesPerUserPerMinute} removal requests in a minute, which is the cap. A large selection is sent in batches of ${ROADMAP_CAPS.directoryBulkRemoveMax}, so it can count as more than one.`}{" "}
            Everything you already removed stayed removed.
          </p>
          <p className="mt-2 text-xs text-faint">
            The buttons turn back on by themselves. You do not need to reload.
            {singleCooling
              ? " To clear many people at once, tick them and use Remove selected."
              : " Removing one person at a time still works, and showing more people per page clears more in each sweep."}
          </p>
        </div>
      )}

      {isAdmin && (
        <div className="panel">
          <span className="sys-label">Import</span>
          <p className="mt-3 text-sm">
            {visibilityNote ??
              `Import only people you are authorized to list. Directory entries are visible to everyone at ${domain} who signs in, and to XL.net.`}
          </p>
          <button
            type="button"
            className="btn mt-4"
            aria-disabled={importBusy}
            aria-busy={importBusy}
            onClick={() => {
              if (importBusy) return;
              void runImport("manual");
            }}
          >
            {importBusy ? "Importing..." : "Import from Apollo"}
          </button>
          {importNote && (
            <p role="status" className="mono mt-3 text-xs text-faint">
              {importNote}
            </p>
          )}
          {importErr && (
            <p role="alert" className="mt-3 text-sm text-red-400">
              {importErr}
            </p>
          )}
          {/* Persistent review duty (round 3): always visible in the import
              area, not only after a run. */}
          <p className="mt-3 text-xs text-faint">
            Review the results and remove anyone you are not authorized to
            list. Removals survive future imports.
          </p>
        </div>
      )}

      {isAdmin && (
        <form onSubmit={addPerson} className="panel">
          <span className="sys-label">Add Person</span>
          <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
            <input
              className={inputCls}
              style={inputStyle}
              value={add.name}
              onChange={(e) => setAdd({ ...add, name: e.target.value })}
              placeholder="Name"
              aria-label="Name"
              required
            />
            <input
              className={inputCls}
              style={inputStyle}
              type="email"
              value={add.email}
              onChange={(e) => setAdd({ ...add, email: e.target.value })}
              placeholder="Email (optional)"
              aria-label="Email"
            />
            <input
              className={inputCls}
              style={inputStyle}
              value={add.phone}
              onChange={(e) => setAdd({ ...add, phone: e.target.value })}
              placeholder="Phone (optional)"
              aria-label="Phone"
            />
            <button
              type="submit"
              className="btn"
              aria-disabled={addBusy || singleCooling}
              aria-busy={addBusy}
            >
              {addBusy ? "Adding..." : "Add"}
            </button>
          </div>
          {addErr && (
            <p role="alert" className="mt-3 text-sm text-red-400">
              {addErr}
            </p>
          )}
          {!addErr && singlePaused && (
            <p className="mt-3 text-xs text-faint">{singlePaused}</p>
          )}
        </form>
      )}

      {/* The live copy. Only this one is role="status", so the outcome is
          announced once no matter which copy the rescue focuses (the same
          one-live-region split PagerStrip and BulkBar use). The twin below
          the table is deliberately NOT aria-hidden the way their duplicates
          are: it is a focus target, and focusable content inside an
          aria-hidden subtree is unreachable for the screen reader that would
          land on it. */}
      {done && (
        <p
          ref={doneTopRef}
          tabIndex={-1}
          role="status"
          className="text-sm text-faint"
        >
          {done}
        </p>
      )}

      {people.length === 0 ? (
        <p className="text-sm text-faint">
          No one listed yet.{" "}
          {isAdmin
            ? "Import your team from Apollo or add the first person above."
            : (memberEmptyLine ?? "Your company admin adds people here.")}
        </p>
      ) : (
        <div className="space-y-4">
          {total > people.length && (
            <p className="mono text-xs text-faint">
              Showing the first {people.length} of {total} people, sorted by
              name.{" "}
              {isAdmin
                ? "Remove people to see the rest."
                : "An admin can remove people to reveal the rest."}
            </p>
          )}

          {pager.showPager && <PagerStrip pager={pagerNav} idPrefix="dir" />}

          {isAdmin && bulkCount > 0 && (
            <BulkBar
              armed={bulkArmed}
              busy={bulkBusy}
              count={bulkCount}
              hidden={hiddenSelected}
              people={selectedPeople}
              suppress={bulkSuppress}
              setSuppress={setBulkSuppress}
              onArm={armBulk}
              onConfirm={() => void confirmBulk()}
              onDisarm={() => setBulkArmed(false)}
              onClear={() => {
                setBulkArmed(false);
                setSelected(new Set());
              }}
              err={bulkErr}
              pausedInline={bulkPaused}
              live
            />
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="mono text-xs uppercase tracking-[0.2em] text-faint">
                  {isAdmin && (
                    <th className="border-b border-[var(--xl-line)] py-2 pr-3 font-normal">
                      <label className="flex min-h-11 min-w-11 items-center">
                        <input
                          type="checkbox"
                          checked={allOnPage}
                          ref={(el) => {
                            if (el)
                              el.indeterminate =
                                pageSelected > 0 && !allOnPage;
                          }}
                          onChange={(e) => togglePage(e.target.checked)}
                          aria-label="Select every person on this page"
                        />
                      </label>
                    </th>
                  )}
                  <th className="border-b border-[var(--xl-line)] py-2 pr-4 font-normal">
                    Name
                  </th>
                  <th className="border-b border-[var(--xl-line)] py-2 pr-4 font-normal">
                    Email
                  </th>
                  <th className="border-b border-[var(--xl-line)] py-2 pr-4 font-normal">
                    Phone
                  </th>
                  {isAdmin && (
                    <th className="border-b border-[var(--xl-line)] py-2 font-normal">
                      Actions
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {pager.windowed.map((p) => (
                  <tr key={p.id} className="align-top">
                    {isAdmin && (
                      <td className="border-b border-[var(--xl-line)] py-2 pr-3">
                        <label className="flex min-h-11 min-w-11 items-center">
                          <input
                            type="checkbox"
                            checked={selected.has(p.id)}
                            onChange={(e) => toggleOne(p.id, e.target.checked)}
                            aria-label={`Select ${p.name}`}
                          />
                        </label>
                      </td>
                    )}
                    {editId === p.id ? (
                      <>
                        <td className="border-b border-[var(--xl-line)] py-2 pr-4">
                          <input
                            className={inputCls}
                            style={inputStyle}
                            value={edit.name}
                            onChange={(e) =>
                              setEdit({ ...edit, name: e.target.value })
                            }
                            aria-label="Name"
                          />
                        </td>
                        <td className="border-b border-[var(--xl-line)] py-2 pr-4">
                          <input
                            className={inputCls}
                            style={inputStyle}
                            type="email"
                            value={edit.email}
                            onChange={(e) =>
                              setEdit({ ...edit, email: e.target.value })
                            }
                            aria-label="Email"
                          />
                        </td>
                        <td className="border-b border-[var(--xl-line)] py-2 pr-4">
                          <input
                            className={inputCls}
                            style={inputStyle}
                            value={edit.phone}
                            onChange={(e) =>
                              setEdit({ ...edit, phone: e.target.value })
                            }
                            aria-label="Phone"
                          />
                        </td>
                        <td className="border-b border-[var(--xl-line)] py-2">
                          <span className="inline-flex flex-wrap items-center gap-3">
                            <button
                              type="button"
                              className="btn btn--text"
                              aria-disabled={rowBusyId !== null || singleCooling}
                              onClick={() => void saveEdit(p.id)}
                            >
                              {rowBusyId === p.id ? "Saving..." : "Save"}
                            </button>
                            <button
                              type="button"
                              className="btn btn--text"
                              aria-disabled={rowBusyId === p.id}
                              onClick={() => {
                                if (rowBusyId === p.id) return;
                                setEditId(null);
                              }}
                            >
                              Cancel
                            </button>
                            <RowNote
                              err={rowErr?.id === p.id ? rowErr.message : null}
                              paused={singlePaused}
                            />
                          </span>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="border-b border-[var(--xl-line)] py-2 pr-4">
                          {p.name}
                        </td>
                        <td className="mono border-b border-[var(--xl-line)] py-2 pr-4 text-xs">
                          {p.email ?? ""}
                        </td>
                        <td className="mono border-b border-[var(--xl-line)] py-2 pr-4 text-xs">
                          {p.phone ?? ""}
                        </td>
                        {isAdmin && (
                          <td className="border-b border-[var(--xl-line)] py-2">
                            {removeId === p.id ? (
                              <span className="inline-flex flex-wrap items-center gap-3">
                                {/* Names the person: the Actions cell is the
                                    last column of a horizontally scrolling
                                    table, so on a phone the Name column can
                                    be off screen while this strip is not. */}
                                <span className="text-xs">
                                  Remove {p.name}?
                                </span>
                                <label className="flex items-center gap-2 text-xs">
                                  <input
                                    type="checkbox"
                                    checked={suppress}
                                    onChange={(e) =>
                                      setSuppress(e.target.checked)
                                    }
                                  />
                                  and keep them out of future imports
                                </label>
                                <button
                                  type="button"
                                  className="btn btn--text"
                                  aria-disabled={rowBusyId !== null || singleCooling}
                                  onClick={() => void confirmRemove(p)}
                                >
                                  {rowBusyId === p.id
                                    ? "Removing..."
                                    : "Confirm remove"}
                                </button>
                                <button
                                  type="button"
                                  className="btn btn--text"
                                  aria-disabled={rowBusyId === p.id}
                                  onClick={() => {
                                    if (rowBusyId === p.id) return;
                                    setRemoveId(null);
                                  }}
                                >
                                  Keep
                                </button>
                                <RowNote
                                  err={
                                    rowErr?.id === p.id ? rowErr.message : null
                                  }
                                  paused={singlePaused}
                                />
                              </span>
                            ) : (
                              <span className="inline-flex flex-wrap items-center gap-3">
                                <button
                                  type="button"
                                  className="btn btn--text"
                                  onClick={() => startEdit(p)}
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  className="btn btn--text"
                                  onClick={() => armRemove(p)}
                                >
                                  Remove
                                </button>
                                <RowNote
                                  err={
                                    rowErr?.id === p.id ? rowErr.message : null
                                  }
                                  paused={null}
                                />
                              </span>
                            )}
                          </td>
                        )}
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* The outcome again, at the bottom edge of the rows. A sweep is
              confirmed from the bulk bar BELOW the table, and its message
              carries the suppression count ("N of them will be skipped by
              future imports") - the half that does not undo itself. With one
              copy above the table only, that sentence was written for an
              admin standing 9000px away from it, which is the dead response
              field confirmBulk's comment refuses to leave it in. */}
          {done && (
            <p ref={doneBottomRef} tabIndex={-1} className="text-sm text-faint">
              {done}
            </p>
          )}

          {isAdmin && bulkCount > 0 && (
            <BulkBar
              armed={bulkArmed}
              busy={bulkBusy}
              count={bulkCount}
              hidden={hiddenSelected}
              people={selectedPeople}
              suppress={bulkSuppress}
              setSuppress={setBulkSuppress}
              onArm={armBulk}
              onConfirm={() => void confirmBulk()}
              onDisarm={() => setBulkArmed(false)}
              onClear={() => {
                setBulkArmed(false);
                setSelected(new Set());
              }}
              err={bulkErr}
              pausedInline={bulkPaused}
            />
          )}

          {pager.showPager && (
            <PagerStrip pager={pagerNav} idPrefix="dir" bottom />
          )}
        </div>
      )}
    </div>
  );
}

/** How far an element sits OUTSIDE the viewport, in px; 0 while any part of
 * it is on screen. Used to choose a focus target, never to scroll to one. */
function viewportGap(el: HTMLElement): number {
  const r = el.getBoundingClientRect();
  const h = window.innerHeight || document.documentElement.clientHeight;
  if (r.bottom >= 0 && r.top <= h) return 0;
  return r.top > h ? r.top - h : -r.bottom;
}

/** Whichever outcome-line copy the admin is nearer to. An on-screen copy
 * always wins (gap 0); a tie goes to the top copy, which is the one that
 * always exists - the bottom copy renders only alongside the rows, so it is
 * absent when the last person has just been removed. */
function nearerToViewport(
  top: HTMLElement | null,
  bottom: HTMLElement | null
): HTMLElement | null {
  if (top === null) return bottom;
  if (bottom === null) return top;
  return viewportGap(bottom) < viewportGap(top) ? bottom : top;
}

/** The failure (or the pause) reported where the click happened, not at the
 * top of a list that may be thousands of pixels away. */
function RowNote({ err, paused }: { err: string | null; paused: string | null }) {
  if (err)
    return (
      <span role="alert" className="text-xs text-red-400">
        {err}
      </span>
    );
  if (paused) return <span className="text-xs text-faint">{paused}</span>;
  return null;
}

/** Rendered above AND below the table so a box ticked at row 240 does not
 * need a 9000px scroll to act on. Only the top copy is a live region.
 *
 * Both buttons are ONE DOM node each whose LABEL switches, never a
 * conditional swap between elements: a keyboard user's focus has to survive
 * the whole arm -> confirm -> result cycle (the same lesson the pager's
 * arrows record). */
function BulkBar({
  armed,
  busy,
  count,
  hidden,
  people,
  suppress,
  setSuppress,
  onArm,
  onConfirm,
  onDisarm,
  onClear,
  err,
  pausedInline,
  live = false,
}: {
  armed: boolean;
  busy: boolean;
  count: number;
  hidden: number;
  people: DirectoryPerson[];
  suppress: boolean;
  setSuppress: (v: boolean) => void;
  onArm: () => void;
  onConfirm: () => void;
  onDisarm: () => void;
  onClear: () => void;
  err: string | null;
  pausedInline: string | null;
  live?: boolean;
}) {
  const noun = count === 1 ? "person" : "people";
  const fromApollo = people.filter((p) => p.source === "apollo").length;
  return (
    <div className="panel">
      <p
        className="text-sm"
        aria-live={live ? "polite" : undefined}
        aria-hidden={live ? undefined : true}
      >
        {armed
          ? `Remove these ${count} ${noun} from the directory? This cannot be undone.`
          : hidden > 0
            ? `${count} ${noun} selected · ${hidden} not on this page.`
            : `${count} ${noun} selected.`}
      </p>

      {armed && (
        <>
          <p className="mt-3 text-xs text-faint">You are removing:</p>
          <ul className="mono mt-1 max-h-40 overflow-y-auto text-xs text-faint">
            {people.map((p) => (
              <li key={p.id}>
                {p.name}
                {p.email ? ` · ${p.email}` : ""}
                {p.source === "apollo" ? " · from Apollo" : ""}
              </li>
            ))}
          </ul>
          {/* The box below defaults ON when ANY selected row came from
              Apollo, so a mixed selection would silently blacklist the
              hand-added ones too. The count and the per-row marker above are
              how that becomes readable before the click. */}
          {fromApollo > 0 && fromApollo < count && (
            <p className="mt-2 text-xs text-faint">
              {fromApollo} of these came from Apollo; the other{" "}
              {count - fromApollo} were added by hand.
            </p>
          )}
          <label className="mt-3 flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={suppress}
              onChange={(e) => setSuppress(e.target.checked)}
            />
            and keep them out of future imports
          </label>
        </>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn"
          aria-disabled={busy || (armed && pausedInline !== null)}
          aria-busy={busy}
          onClick={() => {
            if (busy) return;
            if (armed) onConfirm();
            else onArm();
          }}
        >
          {busy
            ? `Removing ${count}...`
            : armed
              ? `Confirm remove ${count}`
              : `Remove ${count} selected`}
        </button>
        {/* Armed, this DISARMS and keeps the selection: "Keep them" means
            do not delete them, not throw away the selection I just spent
            four pages building. Only the idle label clears. */}
        <button
          type="button"
          className="btn btn--text"
          aria-disabled={busy}
          onClick={() => {
            if (busy) return;
            if (armed) onDisarm();
            else onClear();
          }}
        >
          {armed ? "Keep them" : "Clear selection"}
        </button>
        {err ? (
          <span role="alert" className="text-xs text-red-400">
            {err}
          </span>
        ) : (
          pausedInline && (
            <span className="text-xs text-faint">{pausedInline}</span>
          )
        )}
      </div>
    </div>
  );
}
