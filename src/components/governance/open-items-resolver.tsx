"use client";

// Review-phase open-items resolver (§5.12). Every [TO CONFIRM] marker is a
// fact Tron assumed; a FINAL draft carries none, and each one is resolved by
// the USER: a typed fact (staged here, sent as ONE batched revise turn) or
// an explicit keep-as-drafted (deterministic server-side strip, zero AI).
// A list with single-expansion rows, not a queue: keeps are instant, typed
// answers cost a slow AI turn, and a list lets the user sweep the cheap
// confirms first and pay the AI cost once. The header count is the LENIENT
// server total, which is always true even when the list is sliced or a
// malformed marker cannot be parsed into a row.

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
  featureDisabled: boolean;
  onJump: (doc: string, section: string, focus: boolean) => void;
  onKeep: (item: OpenConfirmItem) => Promise<KeepResult>;
  onSendAnswers: (message: string, focusSections: string[]) => void;
  onAnnounce: (text: string) => void;
}) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");
  const [staged, setStaged] = useState<Record<string, string>>({});
  const [notResolved, setNotResolved] = useState<Set<string>>(new Set());
  const [newKeys, setNewKeys] = useState<Set<string>>(new Set());
  const [keepBusyKey, setKeepBusyKey] = useState<string | null>(null);
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
  const headerRefs = useRef(new Map<string, HTMLButtonElement>());
  const allClearRef = useRef<HTMLParagraphElement | null>(null);

  const storageKey = useCallback(
    (k: string) => `gov:${projectId}:item:${k}`,
    [projectId]
  );

  // Hydrate staged answers typed before a reload (S4 pattern: deferred a
  // tick, like the workspace's own draft restore).
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
    }, 0);
    return () => window.clearTimeout(t);
    // Mount-only by design: later staging writes through setStaged itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Reconcile local state against a fresh item list: resolve/keep staged
   *  answers, migrate keys whose occurrence index shifted, flag rows that
   *  survived a send as Not resolved, and mark newly appeared rows New.
   *  Deferred a tick (workspace S4 idiom) so effects never set state
   *  synchronously during the commit that delivered the new props. */
  useEffect(() => {
    const t = window.setTimeout(() => {
      const keys = items.map(keyOf);
      const keySet = new Set(keys);
      const prev = prevKeysRef.current;
      prevKeysRef.current = keys;

      if (items.length > 0) setHadItems(true);

      const sent = sentRef.current;
      if (sent && rev > sent.rev) {
        sentRef.current = null;
        setSendingKeys(null);
        const surviving = sent.keys.filter((k) => keySet.has(k));
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
      setExpandedKey((ek) => (ek && !keySet.has(ek) ? null : ek));

      if (prev && prev.length) {
        const prevSet = new Set(prev);
        const fresh = keys.filter((k) => !prevSet.has(k));
        if (fresh.length) setNewKeys(new Set(fresh));
      }

      // Focus continuity after a keep removed a row.
      const kp = keepPendingRef.current;
      if (kp && !keySet.has(kp.key)) {
        keepPendingRef.current = null;
        const target =
          kp.nextKey && keySet.has(kp.nextKey)
            ? kp.nextKey
            : kp.prevKey && keySet.has(kp.prevKey)
              ? kp.prevKey
              : null;
        window.requestAnimationFrame(() => {
          if (target) headerRefs.current.get(target)?.focus();
          else allClearRef.current?.focus();
        });
      }
    }, 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, rev, working]);

  if (status !== "review") return null;

  const inputLocked = working || featureDisabled;
  const sendLocked = inputLocked || brainDown;
  const stagedEntries = items
    .filter((it) => staged[keyOf(it)]?.trim())
    .map((it) => ({ item: it, answer: staged[keyOf(it)].trim() }));
  const composedLen = stagedEntries.length
    ? composeResolveMessage(stagedEntries, documents).length
    : 0;
  /** One revise turn may emit only CAPS.turnOpMarkdownMaxChars (8000) of
   *  section markdown, and the model must re-emit every touched section IN
   *  FULL — a batch spanning several large sections fails validation
   *  deterministically and the repair pass cannot fix it (the budget is
   *  inherent to the content). Estimate the re-emit cost as the sum of the
   *  DISTINCT target sections' current markdown (+200 slack each) and stop
   *  staging 1000 chars before the server cap. */
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
    if (sectionRewriteEstimate(entries) > CAPS.turnOpMarkdownMaxChars - 1000)
      return "sections";
    return null;
  };
  const sendBusy = working && sendingKeys !== null;

  const expand = (k: string) => {
    if (expandedKey === k) {
      setExpandedKey(null);
      return;
    }
    setExpandedKey(k);
    setDraftText(staged[k] ?? "");
    setNewKeys((nk) => {
      if (!nk.has(k)) return nk;
      const n = new Set(nk);
      n.delete(k);
      return n;
    });
  };

  const stage = (it: OpenConfirmItem) => {
    const k = keyOf(it);
    const text = draftText.trim();
    if (!text) return;
    setStaged((st) => ({ ...st, [k]: text }));
    try {
      sessionStorage.setItem(storageKey(k), text);
    } catch {
      // storage unavailable
    }
    setExpandedKey(null);
    setError("");
    const remaining = items.filter(
      (x) => !staged[keyOf(x)]?.trim() && keyOf(x) !== k
    ).length;
    onAnnounce(
      `Answer ready for "${truncate(it.excerpt, 40)}". ${remaining} ${remaining === 1 ? "item" : "items"} still open.`
    );
    window.requestAnimationFrame(() => headerRefs.current.get(k)?.focus());
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
    const keys = entries.map((e) => keyOf(e.item));
    sentRef.current = { keys, rev };
    setSendingKeys(keys);
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

  // Group rows under a document heading only when the set spans documents.
  const docsWithItems = documents.filter((d) =>
    items.some((it) => it.doc === d.slug)
  );
  const showDocHeadings = docsWithItems.length > 1;

  const row = (it: OpenConfirmItem) => {
    const k = keyOf(it);
    const expanded = expandedKey === k;
    const isStaged = !!staged[k]?.trim();
    const isNew = newKeys.has(k);
    const failed = notResolved.has(k);
    const keepBusy = keepBusyKey === k;
    return (
      <li
        key={k}
        className="border-b"
        style={{ borderColor: "var(--xl-line)" }}
      >
        <button
          type="button"
          ref={(el) => {
            if (el) headerRefs.current.set(k, el);
            else headerRefs.current.delete(k);
          }}
          className="flex min-h-11 w-full cursor-pointer items-baseline gap-2 py-2 text-left text-sm"
          aria-expanded={expanded}
          onClick={() => expand(k)}
        >
          <span aria-hidden="true" style={faint}>
            {expanded ? "▾" : "▸"}
          </span>
          <span className="min-w-0 flex-1" style={dim} title={it.excerpt}>
            {truncate(it.excerpt, 96)}
          </span>
          {failed && (
            <span
              className="shrink-0 text-xs"
              style={{ color: "var(--xl-danger)" }}
            >
              Not resolved
            </span>
          )}
          {!failed && isStaged && (
            <span
              className="shrink-0 text-xs"
              style={{ color: "var(--xl-light)" }}
            >
              {sendBusy && sendingKeys?.includes(k)
                ? "Sending"
                : "Answer ready"}
            </span>
          )}
          {!failed && !isStaged && isNew && (
            <span
              className="shrink-0 text-xs"
              style={{ color: "var(--xl-warn)" }}
            >
              New
            </span>
          )}
        </button>
        {expanded && (
          <div className="pb-4">
            <p className="max-w-none text-sm" style={dim}>
              {it.contextBefore}
              <span style={{ color: "var(--xl-warn)" }}>
                [TO CONFIRM: {truncate(it.excerpt, 120)}]
              </span>
              {it.contextAfter}
            </p>
            <p className="mt-2 max-w-none text-sm">
              <button
                type="button"
                className="linklike"
                onClick={() => onJump(it.doc, it.section, true)}
              >
                See it in the draft
              </button>
            </p>
            {!it.confirmable && (
              <p className="mt-2 max-w-none text-xs" style={faint}>
                This one needs an answer from you: the marker is the only
                content there, so there is no drafted default to keep.
              </p>
            )}
            {failed && (
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
                stage(it);
              }}
            >
              <input
                type="text"
                className="input mt-3 w-full"
                maxLength={500}
                placeholder="The correct fact, in plain words"
                aria-label={`Your answer for ${truncate(it.excerpt, 60)}`}
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
                    wouldExceed(it, draftText) !== null
                  }
                >
                  Add answer
                </button>
                {failed && isStaged && (
                  <button
                    type="button"
                    className="btn btn--text"
                    disabled={sendLocked}
                    onClick={() =>
                      sendEntries([{ item: it, answer: staged[k].trim() }])
                    }
                  >
                    Send just this one
                  </button>
                )}
                {it.confirmable && (
                  <button
                    type="button"
                    className="btn btn--text btn--stable"
                    aria-busy={keepBusy || undefined}
                    disabled={inputLocked || keepBusyKey !== null}
                    onClick={() => void keep(it)}
                  >
                    <BusyLabel
                      busy={keepBusy}
                      idle="Keep as drafted"
                      busyText="Keeping"
                    />
                  </button>
                )}
              </div>
              {draftText.trim() !== "" && wouldExceed(it, draftText) !== null && (
                <p className="mt-2 max-w-none text-xs" style={faint}>
                  {wouldExceed(it, draftText) === "chars"
                    ? "That is the 2000 character limit for one revision. Send these answers first, then add the rest."
                    : "That is as much of the draft as one revision can rewrite. Send these answers first, then add the rest."}
                </p>
              )}
            </form>
          </div>
        )}
      </li>
    );
  };

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
      {items.length >= 50 && total > items.length && (
        <p className="mt-2 max-w-none text-xs" style={faint}>
          Showing the first 50 of {total}. More appear as you resolve these.
        </p>
      )}
      <ul className="mt-2" aria-label="Open items to confirm">
        {showDocHeadings
          ? docsWithItems.map((d) => (
              <li key={d.slug} className="list-none">
                <span className="sys-label mt-3 block">{d.title}</span>
                <ul>{items.filter((it) => it.doc === d.slug).map(row)}</ul>
              </li>
            ))
          : items.map(row)}
      </ul>
      {unlisted > 0 && items.length < 50 && (
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
