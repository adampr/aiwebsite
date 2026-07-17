"use client";

// Review-phase open-items resolver (§5.12). Every [TO CONFIRM] marker is a
// fact Tron assumed; a FINAL draft carries none, and each one is resolved by
// the USER: a typed fact (staged here, sent as ONE batched revise turn) or
// an explicit keep-as-drafted (deterministic server-side strip, zero AI).
// Owner rule 2026-07-17: asking the user for a fact ALWAYS uses the question
// card structure, in review exactly as in drafting. So this renders ONE item
// at a time in a card mirroring the drafting chase card (sys-label header +
// counter chip, question-formula heading, context quote with the highlighted
// marker, jump link, answer form), with a closed-by-default chip queue for
// random access. The batching economics survive unchanged: "Add answer"
// stages locally (nothing is sent), keeps are instant, and the one glowing
// primary ("Send N answers") fires a single batched revise turn. "Send" is
// reserved for actions that actually run the AI. The header count is the
// LENIENT server total, which is always true even when the list is sliced
// or a malformed marker cannot be parsed into a row.

import { useCallback, useEffect, useRef, useState } from "react";
import { CAPS } from "@/lib/governance/config";
import type {
  GovernanceDoc,
  OpenConfirmItem,
  ProjectStatus,
} from "@/lib/governance/types";
import { BusyLabel, WorkingRow, type WorkingKind } from "./shared";

const faint = { color: "var(--xl-text-faint)" } as const;
const dim = { color: "var(--xl-text-dim)" } as const;

const MESSAGE_FRAME =
  "Resolve these open [TO CONFIRM] items with the facts below. Fold each fact into the surrounding text and delete that marker. Do not touch any other marker.";

function hash36(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Stable row key. Excerpt is hashed (short, storage-safe); occurrence keeps
 *  identical markers in one section distinguishable. */
function keyOf(it: OpenConfirmItem): string {
  return `${it.doc}:${it.section}:${hash36(it.excerpt)}:${it.occurrence}`;
}

function keyPrefix(it: OpenConfirmItem): string {
  return `${it.doc}:${it.section}:${hash36(it.excerpt)}:`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(" ");
  return (sp > n / 2 ? cut.slice(0, sp) : cut) + "...";
}

export interface KeepResult {
  ok: boolean;
  message?: string;
}

export function composeResolveMessage(
  entries: { item: OpenConfirmItem; answer: string }[],
  documents: GovernanceDoc[]
): string {
  const lines = entries.map((e, i) => {
    const doc = documents.find((d) => d.slug === e.item.doc);
    const sec = doc?.sections.find((s) => s.id === e.item.section);
    return `${i + 1}. In "${doc?.title ?? e.item.doc}", section "${sec?.title ?? e.item.section}", the item "${truncate(e.item.excerpt, 60)}": ${e.answer}`;
  });
  return `${MESSAGE_FRAME}\n${lines.join("\n")}`;
}

export function OpenItemsResolver({
  projectId,
  items,
  total,
  documents,
  status,
  rev,
  working,
  workingKind,
  workingLong,
  brainDown,
  restyleActive,
  featureDisabled,
  onJump,
  onKeep,
  onSendAnswers,
  onAnnounce,
}: {
  projectId: string;
  items: OpenConfirmItem[];
  total: number;
  documents: GovernanceDoc[];
  status: ProjectStatus;
  rev: number;
  working: boolean;
  workingKind: WorkingKind;
  workingLong: boolean;
  brainDown: boolean;
  // A reformat run holds its latch across inter-pass gaps where `working`
  // briefly drops; sends AND keeps must stay locked for its whole span (a
  // keep mutates the document under the run's pending pass).
  restyleActive: boolean;
  featureDisabled: boolean;
  onJump: (doc: string, section: string, focus: boolean) => void;
  onKeep: (item: OpenConfirmItem) => Promise<KeepResult>;
  onSendAnswers: (message: string, focusSections: string[]) => void;
  onAnnounce: (text: string) => void;
}) {
  const [cursorKey, setCursorKey] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");
  const [staged, setStaged] = useState<Record<string, string>>({});
  const [notResolved, setNotResolved] = useState<Set<string>>(new Set());
  const [newKeys, setNewKeys] = useState<Set<string>>(new Set());
  const [keepBusyKey, setKeepBusyKey] = useState<string | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [error, setError] = useState("");
  // The in-flight batch: ref for effect logic (never stale), state mirror
  // for render (the lint rule forbids ref reads during render).
  const sentRef = useRef<{ keys: string[]; rev: number } | null>(null);
  const [sendingKeys, setSendingKeys] = useState<string[] | null>(null);
  const [hadItems, setHadItems] = useState(false);
  const keepPendingRef = useRef<{
    key: string;
    nextKey: string | null;
    prevKey: string | null;
  } | null>(null);
  const prevKeysRef = useRef<string[] | null>(null);
  const cursorRef = useRef<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const sendBtnRef = useRef<HTMLButtonElement | null>(null);
  const allClearRef = useRef<HTMLParagraphElement | null>(null);

  const storageKey = useCallback(
    (k: string) => `gov:${projectId}:item:${k}`,
    [projectId]
  );
  const cursorStore = `gov:${projectId}:resolver:cursor`;
  const queueStore = `gov:${projectId}:resolver:queue`;

  // Hydrate staged answers, the cursor, and the queue toggle typed/set
  // before a reload (S4 pattern: deferred a tick, like the workspace's own
  // draft restore).
  useEffect(() => {
    const t = window.setTimeout(() => {
      const found: Record<string, string> = {};
      for (const it of items) {
        const k = keyOf(it);
        try {
          const v = sessionStorage.getItem(storageKey(k));
          if (v) found[k] = v;
        } catch {
          // storage unavailable
        }
      }
      if (Object.keys(found).length) setStaged((s) => ({ ...found, ...s }));
      try {
        const c = sessionStorage.getItem(cursorStore);
        if (c && items.some((it) => keyOf(it) === c)) {
          cursorRef.current = c;
          setCursorKey(c);
          if (found[c]) setDraftText((d) => d || found[c]);
        } else if (items.length) {
          const first = keyOf(items[0]);
          if (found[first]) setDraftText((d) => d || found[first]);
        }
        if (sessionStorage.getItem(queueStore) === "1") setQueueOpen(true);
      } catch {
        // storage unavailable
      }
    }, 0);
    return () => window.clearTimeout(t);
    // Mount-only by design: later staging writes through setStaged itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Reconcile local state against a fresh item list: resolve/keep staged
   *  answers, migrate keys whose occurrence index shifted, flag rows that
   *  survived a send as Not resolved, mark newly appeared rows New, and
   *  keep the cursor pointing at a live row (focus continuity: heading
   *  after a keep or a partial batch, the all-clear paragraph when the
   *  queue empties). The resolver never pushes to the live region after a
   *  batch: the workspace owns that receipt (true total delta) and the
   *  region replaces, never appends. Deferred a tick (workspace S4 idiom)
   *  so effects never set state synchronously during the commit that
   *  delivered the new props. */
  useEffect(() => {
    const t = window.setTimeout(() => {
      const keys = items.map(keyOf);
      const keySet = new Set(keys);
      const prev = prevKeysRef.current;
      prevKeysRef.current = keys;

      if (items.length > 0) setHadItems(true);

      const sent = sentRef.current;
      let batchLanded = false;
      let surviving: string[] = [];
      if (sent && rev > sent.rev) {
        batchLanded = true;
        sentRef.current = null;
        setSendingKeys(null);
        surviving = sent.keys.filter((k) => keySet.has(k));
        if (surviving.length)
          setNotResolved((nr) => new Set([...nr, ...surviving]));
        setStaged((st) => {
          const n = { ...st };
          for (const k of sent.keys)
            if (!keySet.has(k)) {
              delete n[k];
              try {
                sessionStorage.removeItem(storageKey(k));
              } catch {
                // storage unavailable
              }
            }
          return n;
        });
      } else if (sent && !working && rev === sent.rev) {
        // The turn failed outright; everything stays staged, nothing lost.
        sentRef.current = null;
        setSendingKeys(null);
      }

      // Migrate staged text whose occurrence index shifted (an earlier
      // identical marker was resolved), then prune what truly vanished.
      setStaged((st) => {
        let changed = false;
        const n = { ...st };
        for (const k of Object.keys(st)) {
          if (keySet.has(k)) continue;
          const prefix = k.slice(0, k.lastIndexOf(":") + 1);
          const target = items.find(
            (it) => keyPrefix(it) === prefix && !(keyOf(it) in n)
          );
          changed = true;
          if (target) n[keyOf(target)] = st[k];
          delete n[k];
          try {
            sessionStorage.removeItem(storageKey(k));
            if (target)
              sessionStorage.setItem(storageKey(keyOf(target)), st[k]);
          } catch {
            // storage unavailable
          }
        }
        return changed ? n : st;
      });
      setNotResolved((nr) => {
        const kept = [...nr].filter((k) => keySet.has(k));
        return kept.length === nr.size ? nr : new Set(kept);
      });

      // New rows keep their flag until the USER visits or stages them; a
      // programmatic cursor landing must not burn it.
      if (prev && prev.length) {
        const prevSet = new Set(prev);
        const fresh = keys.filter((k) => !prevSet.has(k));
        if (fresh.length) setNewKeys((nk) => new Set([...nk, ...fresh]));
      }

      // Cursor + focus continuity.
      let nextCursor = cursorRef.current;
      let focusTarget: "heading" | "allclear" | null = null;
      const kp = keepPendingRef.current;
      if (kp && !keySet.has(kp.key)) {
        keepPendingRef.current = null;
        nextCursor =
          kp.nextKey && keySet.has(kp.nextKey)
            ? kp.nextKey
            : kp.prevKey && keySet.has(kp.prevKey)
              ? kp.prevKey
              : null;
        focusTarget = nextCursor ? "heading" : "allclear";
      }
      if (batchLanded) {
        if (surviving.length) {
          nextCursor = surviving[0];
          focusTarget = "heading";
        } else {
          // Full success: the focused Send button is about to unmount.
          focusTarget = keys.length ? "heading" : "allclear";
        }
      }
      if (nextCursor && !keySet.has(nextCursor)) {
        const pi = prev ? prev.indexOf(nextCursor) : -1;
        nextCursor = keys.length
          ? keys[Math.min(Math.max(pi, 0), keys.length - 1)]
          : null;
      }
      if (!nextCursor && keys.length) nextCursor = keys[0];
      if (nextCursor !== cursorRef.current) {
        cursorRef.current = nextCursor;
        setCursorKey(nextCursor);
        let v: string | null = null;
        if (nextCursor) {
          try {
            v = sessionStorage.getItem(storageKey(nextCursor));
          } catch {
            // storage unavailable
          }
        }
        setDraftText(v ?? "");
      }
      if (focusTarget) {
        const target = focusTarget;
        window.requestAnimationFrame(() => {
          if (target === "heading") headingRef.current?.focus();
          else allClearRef.current?.focus();
        });
      }
    }, 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, rev, working]);

  if (status !== "review") return null;

  const inputLocked = working || featureDisabled || restyleActive;
  const sendLocked = inputLocked || brainDown;
  const stagedEntries = items
    .filter((it) => staged[keyOf(it)]?.trim())
    .map((it) => ({ item: it, answer: staged[keyOf(it)].trim() }));
  const composedLen = stagedEntries.length
    ? composeResolveMessage(stagedEntries, documents).length
    : 0;
  /** One revise turn is told to emit at most CAPS.turnOpMarkdownTargetChars
   *  of section markdown (validation allows more; the gap is the model's
   *  miscounting margin, not batch headroom), and the model must re-emit
   *  every touched section IN FULL: a batch whose inherent re-emit cost
   *  exceeds what the model is told produces truncated rewrites or
   *  deterministic validation failures the repair pass cannot fix. Estimate
   *  the re-emit cost as the sum of the DISTINCT target sections' current
   *  markdown (+200 slack each) and stop staging 1000 chars before the
   *  stated target. */
  const sectionRewriteEstimate = (
    entries: { item: OpenConfirmItem; answer: string }[]
  ): number => {
    const seen = new Set<string>();
    let sum = 0;
    for (const e of entries) {
      const k = `${e.item.doc}#${e.item.section}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const doc = documents.find((d) => d.slug === e.item.doc);
      const sec = doc?.sections.find((s) => s.id === e.item.section);
      sum += (sec?.markdown.length ?? 0) + 200;
    }
    return sum;
  };
  const wouldExceed = (
    candidate: OpenConfirmItem,
    text: string
  ): "chars" | "sections" | null => {
    const k = keyOf(candidate);
    const entries = [
      ...stagedEntries.filter((e) => keyOf(e.item) !== k),
      { item: candidate, answer: text.trim() },
    ];
    if (composeResolveMessage(entries, documents).length > 2000)
      return "chars";
    if (sectionRewriteEstimate(entries) > CAPS.turnOpMarkdownTargetChars - 1000)
      return "sections";
    return null;
  };
  const sendBusy = working && sendingKeys !== null;

  const keys = items.map(keyOf);
  const currentKey =
    cursorKey && keys.includes(cursorKey) ? cursorKey : (keys[0] ?? null);
  const idx = currentKey ? keys.indexOf(currentKey) : -1;
  const current = idx >= 0 ? items[idx] : null;
  const n = items.length;
  const listed = total > n;

  const moveCursor = (key: string, user: boolean) => {
    cursorRef.current = key;
    setCursorKey(key);
    setDraftText(staged[key] ?? "");
    if (user)
      setNewKeys((nk) => {
        if (!nk.has(key)) return nk;
        const next = new Set(nk);
        next.delete(key);
        return next;
      });
    try {
      sessionStorage.setItem(cursorStore, key);
    } catch {
      // storage unavailable
    }
  };

  const goTo = (key: string) => {
    moveCursor(key, true);
    window.requestAnimationFrame(() => headingRef.current?.focus());
  };

  /** Add stages and advances to the next unstaged item (forward scan with
   *  wraparound: the job is "take me to what still needs me"); Update stays
   *  put (the user came back to fix a typo, not to move). Neither sends. */
  const submitAnswer = (it: OpenConfirmItem) => {
    const k = keyOf(it);
    const text = draftText.trim();
    if (!text) return;
    const wasStaged = !!staged[k]?.trim();
    const nextStaged = { ...staged, [k]: text };
    setStaged(nextStaged);
    try {
      sessionStorage.setItem(storageKey(k), text);
    } catch {
      // storage unavailable
    }
    setError("");
    setNewKeys((nk) => {
      if (!nk.has(k)) return nk;
      const next = new Set(nk);
      next.delete(k);
      return next;
    });
    const readyCount = items.filter((x) =>
      nextStaged[keyOf(x)]?.trim()
    ).length;
    if (wasStaged) {
      onAnnounce(
        `Answer updated. ${readyCount} ready to send.`
      );
      return;
    }
    const from = items.findIndex((x) => keyOf(x) === k);
    const ordered = [...items.slice(from + 1), ...items.slice(0, from)];
    const dest = ordered.find((x) => !nextStaged[keyOf(x)]?.trim());
    const open = n - readyCount;
    if (!dest) {
      onAnnounce(`Answer ready. All ${n} ready to send.`);
      window.requestAnimationFrame(() => sendBtnRef.current?.focus());
      return;
    }
    const destIdx = items.findIndex((x) => keyOf(x) === keyOf(dest));
    moveCursor(keyOf(dest), false);
    onAnnounce(
      destIdx < from
        ? `Answer ready. Moved back to item ${destIdx + 1} of ${n}; ${open} still ${open === 1 ? "needs" : "need"} one.`
        : `Answer ready. ${open} of ${n} still ${open === 1 ? "needs" : "need"} one.`
    );
    window.requestAnimationFrame(() => headingRef.current?.focus());
  };

  const removeAnswer = (it: OpenConfirmItem) => {
    const k = keyOf(it);
    const nextStaged = { ...staged };
    delete nextStaged[k];
    setStaged(nextStaged);
    try {
      sessionStorage.removeItem(storageKey(k));
    } catch {
      // storage unavailable
    }
    const readyCount = items.filter((x) =>
      nextStaged[keyOf(x)]?.trim()
    ).length;
    onAnnounce(`Answer removed. ${readyCount} still ready to send.`);
  };

  const keep = async (it: OpenConfirmItem) => {
    const k = keyOf(it);
    const ordered = items.map(keyOf);
    const i = ordered.indexOf(k);
    keepPendingRef.current = {
      key: k,
      nextKey: ordered[i + 1] ?? null,
      prevKey: ordered[i - 1] ?? null,
    };
    setKeepBusyKey(k);
    setError("");
    const r = await onKeep(it);
    setKeepBusyKey(null);
    if (!r.ok) {
      keepPendingRef.current = null;
      if (r.message) setError(r.message);
    }
  };

  const sendEntries = (entries: { item: OpenConfirmItem; answer: string }[]) => {
    if (!entries.length) return;
    setError("");
    const sendKeys = entries.map((e) => keyOf(e.item));
    sentRef.current = { keys: sendKeys, rev };
    setSendingKeys(sendKeys);
    const sections = [
      ...new Set(entries.map((e) => `${e.item.doc}#${e.item.section}`)),
    ];
    onSendAnswers(composeResolveMessage(entries, documents), sections);
  };

  const unlisted = Math.max(0, total - items.length);

  if (total === 0) {
    if (!hadItems) return null;
    return (
      <p
        ref={allClearRef}
        tabIndex={-1}
        className="mt-5 max-w-none text-sm"
        style={{ outline: "none" }}
      >
        Every open item is resolved. Confirm the draft below when it reads
        right; your counsel still reviews it before adoption.
      </p>
    );
  }

  /** The card heading reuses the drafting chase-question formula verbatim
   *  (turn.ts pickOpenItemQuestion), fallback included: the SAME question
   *  structure, worded the same way, is the whole point. */
  const headingFor = (it: OpenConfirmItem): string => {
    const doc = documents.find((d) => d.slug === it.doc);
    const sec = doc?.sections.find((s) => s.id === it.section);
    const where = `the "${truncate(sec?.title ?? it.section, 60)}" section of "${truncate(doc?.title ?? it.doc, 60)}"`;
    const ex = it.excerpt.trim();
    return ex
      ? `In ${where} I drafted an assumption marked [TO CONFIRM: ${truncate(ex, 80)}]. What is the right answer here?`
      : `In ${where} an item is still marked [TO CONFIRM]. What is the right answer here?`;
  };

  // Group queue chips under a document heading only when the set spans
  // documents; chip indices stay global so they match "Open item K of N".
  const docsWithItems = documents.filter((d) =>
    items.some((it) => it.doc === d.slug)
  );
  const showDocHeadings = docsWithItems.length > 1;

  const chip = (it: OpenConfirmItem) => {
    const k = keyOf(it);
    const i = keys.indexOf(k);
    const isStaged = !!staged[k]?.trim();
    const failed = notResolved.has(k);
    const isNew = newKeys.has(k);
    const sending = sendBusy && !!sendingKeys?.includes(k);
    // Words carry the state (never color alone); the classes are garnish.
    const suffix = failed
      ? "not resolved"
      : isStaged
        ? sending
          ? "sending"
          : "ready"
        : isNew
          ? "new"
          : null;
    return (
      <button
        key={k}
        type="button"
        className={`gov-chip${failed ? " gov-chip--danger" : isStaged ? " gov-chip--staged" : ""}`}
        aria-current={k === currentKey ? "true" : undefined}
        title={it.excerpt}
        aria-label={`Open item ${i + 1}: ${truncate(it.excerpt, 60)}.${suffix ? ` ${suffix[0].toUpperCase()}${suffix.slice(1)}.` : ""}`}
        onClick={() => goTo(k)}
      >
        {i + 1} · {truncate(it.excerpt, 28)}
        {suffix && <span> · {suffix}</span>}
      </button>
    );
  };

  const isStagedCurrent = current ? !!staged[currentKey!]?.trim() : false;
  const identical =
    isStagedCurrent && draftText.trim() === staged[currentKey!].trim();
  const failedCurrent = current ? notResolved.has(currentKey!) : false;
  const keepBusy = current ? keepBusyKey === currentKey : false;
  const exceed =
    current && draftText.trim() ? wouldExceed(current, draftText) : null;
  const readyCount = stagedEntries.length;
  const toGo = n - items.filter((it) => staged[keyOf(it)]?.trim()).length;

  return (
    <div className="mt-5">
      <p className="text-sm">
        <strong>Open items to confirm ({total})</strong>
      </p>
      <p className="mt-1 max-w-none text-sm" style={dim}>
        Each of these is a fact I assumed. Tell me the right answer, or keep
        what I drafted if it is already correct.
      </p>
      {featureDisabled && (
        <p className="mt-2 max-w-none text-sm" style={faint}>
          Drafting is paused right now. Your open items wait right here;
          nothing is lost.
        </p>
      )}

      {current && (
        <div className="panel mt-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span id="oi-position" className="sys-label">
              Open item {String(idx + 1).padStart(2, "0")} of {n}
              {listed ? " listed" : ""}
            </span>
            <span className="text-xs" style={faint}>
              {total === 1
                ? "1 open item left"
                : `${total} open items left · one answer can clear several`}
            </span>
          </div>
          <h4
            ref={headingRef}
            tabIndex={-1}
            className="doc-h mt-4 text-lg"
            aria-describedby="oi-position"
          >
            {headingFor(current)}
          </h4>
          <p className="mt-2 max-w-none text-sm" style={dim}>
            Keeping is instant; typed answers go together as one revision.
          </p>
          <p className="mt-3 max-w-none text-sm" style={dim}>
            {current.contextBefore}
            <mark className="doc-confirm">
              [TO CONFIRM: {truncate(current.excerpt, 120)}]
            </mark>
            {current.contextAfter}
          </p>
          <p className="mt-2 max-w-none text-sm">
            <button
              type="button"
              className="linklike"
              onClick={() => onJump(current.doc, current.section, true)}
            >
              See the text this is about
            </button>
          </p>
          {!current.confirmable && (
            <p className="mt-2 max-w-none text-xs" style={faint}>
              This one needs an answer from you: the marker is the only
              content there, so there is no drafted default to keep.
            </p>
          )}
          {failedCurrent && (
            <p
              className="mt-2 max-w-none text-sm"
              style={{ color: "var(--xl-danger)" }}
            >
              I did not manage to fold this one in. Send it again by itself,
              or keep it as drafted if the text already reads right.
            </p>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitAnswer(current);
            }}
          >
            <textarea
              className="input mt-3 w-full"
              rows={2}
              maxLength={500}
              placeholder="The correct fact, in plain words"
              aria-label={`Your answer for open item ${idx + 1}: ${truncate(current.excerpt, 60)}`}
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              disabled={inputLocked}
            />
            <div className="mt-3 flex flex-wrap items-center gap-6">
              <button
                type="submit"
                className="btn"
                disabled={
                  inputLocked ||
                  !draftText.trim() ||
                  identical ||
                  exceed !== null
                }
              >
                {isStagedCurrent ? "Update answer" : "Add answer"}
              </button>
              {failedCurrent && isStagedCurrent && (
                <button
                  type="button"
                  className="btn btn--text"
                  disabled={sendLocked}
                  onClick={() =>
                    sendEntries([
                      { item: current, answer: staged[currentKey!].trim() },
                    ])
                  }
                >
                  Send just this one
                </button>
              )}
              {current.confirmable && (
                <button
                  type="button"
                  className="btn btn--text btn--stable"
                  aria-busy={keepBusy || undefined}
                  disabled={inputLocked || keepBusyKey !== null}
                  onClick={() => void keep(current)}
                >
                  <BusyLabel
                    busy={keepBusy}
                    idle="Keep as drafted"
                    busyText="Keeping"
                  />
                </button>
              )}
              {isStagedCurrent && (
                <button
                  type="button"
                  className="btn btn--text"
                  disabled={inputLocked}
                  onClick={() => removeAnswer(current)}
                >
                  Remove this answer
                </button>
              )}
            </div>
            {exceed !== null && (
              <p className="mt-2 max-w-none text-xs" style={faint}>
                {exceed === "chars"
                  ? "That is the 2000 character limit for one revision. Send these answers first, then add the rest."
                  : "That is as much of the draft as one revision can rewrite. Send these answers first, then add the rest."}
              </p>
            )}
            <p className="mt-3 max-w-none text-xs" style={faint}>
              Added answers are not sent yet. They go together in one
              revision when you press Send below.
            </p>
            {restyleActive && (
              <p className="mt-3 max-w-none text-sm" style={dim}>
                Paused while I reformat the draft to match your sample. These
                items are not going anywhere.
              </p>
            )}
          </form>
          {n > 1 && (
            <div className="mt-4 flex flex-wrap items-center gap-6">
              <button
                type="button"
                className="btn btn--text"
                disabled={idx === 0}
                onClick={() => goTo(keys[idx - 1])}
              >
                Previous item
              </button>
              <button
                type="button"
                className="btn btn--text"
                disabled={idx === n - 1}
                onClick={() => goTo(keys[idx + 1])}
              >
                Next item
              </button>
            </div>
          )}
        </div>
      )}

      {!current && (
        <p className="mt-2 max-w-none text-xs" style={faint}>
          {total} open {total === 1 ? "item remains" : "items remain"} but I
          could not display {total === 1 ? "it" : "them"} cleanly. Ask me to
          fix {total === 1 ? "it" : "them"} in the revision box below.
        </p>
      )}

      {n > 1 && (
        <details
          className="mt-4"
          open={queueOpen}
          onToggle={(e) => {
            const open = e.currentTarget.open;
            setQueueOpen(open);
            try {
              sessionStorage.setItem(queueStore, open ? "1" : "0");
            } catch {
              // storage unavailable
            }
          }}
        >
          <summary
            className="min-h-11 cursor-pointer py-2 text-sm"
            style={dim}
          >
            {listed ? "Listed open items" : "All open items"} · {readyCount}{" "}
            ready, {toGo} to go
          </summary>
          {showDocHeadings ? (
            docsWithItems.map((d) => (
              <div key={d.slug}>
                <span className="sys-label mt-3 block">{d.title}</span>
                <div className="mt-2 flex flex-wrap gap-2">
                  {items.filter((it) => it.doc === d.slug).map(chip)}
                </div>
              </div>
            ))
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">{items.map(chip)}</div>
          )}
        </details>
      )}

      {items.length >= 50 && total > items.length && (
        <p className="mt-2 max-w-none text-xs" style={faint}>
          Showing the first 50 of {total}. More appear as you resolve these.
        </p>
      )}
      {current && unlisted > 0 && items.length < 50 && (
        <p className="mt-2 max-w-none text-xs" style={faint}>
          {unlisted} {unlisted === 1 ? "item" : "items"} I could not display
          cleanly. Ask me to fix {unlisted === 1 ? "it" : "them"} in the
          revision box below.
        </p>
      )}

      {stagedEntries.length > 0 && (
        <div className="answer-sticky mt-4 pt-2">
          <div className="flex flex-wrap items-center gap-4">
            <button
              ref={sendBtnRef}
              type="button"
              className="btn btn--primary btn--stable"
              aria-busy={sendBusy || undefined}
              disabled={sendLocked}
              onClick={() => sendEntries(stagedEntries)}
            >
              <BusyLabel
                busy={sendBusy}
                idle={`Send ${stagedEntries.length} ${stagedEntries.length === 1 ? "answer" : "answers"}`}
                busyText="Sending"
              />
            </button>
            <span className="text-xs" style={faint}>
              About {composedLen} of 2000 characters
            </span>
          </div>
        </div>
      )}
      {working && workingKind === "resolve" && (
        <WorkingRow long={workingLong} kind="resolve" />
      )}
      {brainDown && !working && (
        <p
          className="mt-3 max-w-none text-sm"
          style={{ color: "var(--xl-warn)" }}
        >
          Tron&apos;s drafting engine is offline right now. Answers you add
          are kept here, and Keep as drafted still works. Send comes back
          when he is back.
        </p>
      )}
      {error && (
        <p
          className="mt-3 max-w-none text-sm"
          style={{ color: "var(--xl-danger)" }}
        >
          {error}
        </p>
      )}
    </div>
  );
}
