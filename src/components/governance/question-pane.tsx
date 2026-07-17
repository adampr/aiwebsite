"use client";

// Left column of the workspace: prior Q&A transcript, the current question
// card + answer form (drafting), the review panel (review), and the final
// panel (done). Errors here are visual text only; announcements go through
// the workspace's single polite live region.

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type {
  OpenConfirmItem,
  ProjectView,
  TranscriptEntry,
} from "@/lib/governance/types";
import {
  foldTranscript,
  isChaseId,
  isQuestionEntry,
  questionNumber,
  remapLegacyReopenedSummary,
  type EffectiveEntry,
} from "@/lib/governance/interview";
import { sectionTitleText } from "@/lib/governance/numbering";
import {
  BusyLabel,
  chipCanon,
  chipSegments,
  firstFeedTarget,
  fmtDate,
  WorkingRow,
  type WorkingKind,
} from "./shared";
import { OpenItemsResolver, type KeepResult } from "./open-items-resolver";

const faint = { color: "var(--xl-text-faint)" } as const;
const dim = { color: "var(--xl-text-dim)" } as const;

export interface WorkspaceNotice {
  kind: "info" | "error";
  text: string;
}

export type { WorkingKind };

const REVIEW_DEFAULT_COPY =
  "No more questions. Read the draft on the right. Your answers below are the facts it is built on; change any of them if one is wrong, or ask for any other change in the box under them. When it reads right and every open item is resolved, confirm it and take it with you.";

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(" ");
  return (sp > n / 2 ? cut.slice(0, sp) : cut) + "...";
}

/** The Q&A history, in two presentations (round 15, owner report: "not
 *  letting me change previous answers"):
 *
 *  - "quiet" (drafting and done): one collapsed disclosure so the current
 *    question card stays the top anchor of the column (round-8 decision).
 *    Uncontrolled and unkeyed so the open state survives turn re-renders.
 *  - "promoted" (review, rendered INSIDE the review panel): a first-class
 *    "Your answers" block with flat rows and always-visible Change buttons.
 *    In review there is no question card to protect, and burying the amend
 *    editor two disclosures deep read as "you cannot edit answers".
 *
 *  Exactly ONE instance is ever mounted (two would cross-leak the per-row
 *  sessionStorage drafts). Amend rows are FOLDED into the question row they
 *  correct (interview.ts): each question shows its latest effective answer
 *  plus a "was" line, and the editor sends a non-advancing amend turn.
 *  Question numbering uses the same isQuestionEntry predicate as the header
 *  counter, so the two can never disagree. */
function TranscriptList({
  view,
  projectId,
  working,
  workingKind,
  workingLong,
  brainDown,
  featureDisabled,
  onAmend,
  variant,
  fallbackFocusRef,
}: {
  view: ProjectView;
  projectId: string;
  working: boolean;
  workingKind: WorkingKind;
  workingLong: boolean;
  brainDown: boolean;
  featureDisabled: boolean;
  onAmend: (index: number, answer: string) => void;
  variant: "quiet" | "promoted";
  fallbackFocusRef?: RefObject<HTMLHeadingElement | null>;
}) {
  const [editorIndex, setEditorIndex] = useState<number | null>(null);
  const [editorText, setEditorText] = useState("");
  // The in-flight amend: ref for effect logic, state mirror for render (the
  // lint rule forbids ref reads during render). prevAmendedAt lets a landed
  // turn (which appends an amend row and moves amendedAt) be told apart
  // from a failed one.
  const pendingRef = useRef<{ index: number; prevAmendedAt: string | null } | null>(null);
  const [amendingIndex, setAmendingIndex] = useState<number | null>(null);
  // Per-row focus target after a landed amend: the row's <summary> (quiet)
  // or its Change button (promoted).
  const rowRefs = useRef(new Map<number, HTMLElement>());
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const folded = foldTranscript(view.transcript);
  const canAmend =
    (view.status === "drafting" || view.status === "review") &&
    !featureDisabled;

  const draftKey = (i: number) => `gov:${projectId}:amend:${i}`;

  // Resolve an in-flight amend once the workspace lock releases: landed =
  // the folded row's amendedAt moved (close + clean), failed = unchanged
  // (keep the editor and its text; the workspace notice explains).
  useEffect(() => {
    const p = pendingRef.current;
    if (!p || working) return;
    const row = folded.find((r) => r.index === p.index);
    if (row && row.amendedAt !== p.prevAmendedAt) {
      pendingRef.current = null;
      setAmendingIndex(null);
      setEditorIndex((cur) => (cur === p.index ? null : cur));
      try {
        sessionStorage.removeItem(draftKey(p.index));
      } catch {
        // storage unavailable
      }
      // The row's focus target can be gone (status flipped, list remounted):
      // fall back to the panel heading rather than dropping focus on body.
      window.requestAnimationFrame(() =>
        (rowRefs.current.get(p.index) ?? fallbackFocusRef?.current)?.focus()
      );
    } else if (row) {
      pendingRef.current = null; // failed: editor stays open, text intact
      setAmendingIndex(null);
    }
    // draftKey is stable per projectId; folded derives from view.transcript.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [working, view.transcript]);

  const openEditor = (row: EffectiveEntry) => {
    let saved: string | null = null;
    try {
      saved = sessionStorage.getItem(draftKey(row.index));
      // A draft equal to the current answer is a leftover from an amend that
      // landed while this list was unmounted (status flip mid-turn): keeping
      // it would prefill an editor whose Send is dead on the identical guard.
      if (saved !== null && saved.trim() === row.effectiveAnswer.trim()) {
        saved = null;
        sessionStorage.removeItem(draftKey(row.index));
      }
    } catch {
      // storage unavailable
    }
    setEditorIndex(row.index);
    setEditorText(saved ?? (row.effectiveSkipped ? "" : row.effectiveAnswer));
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const setText = (i: number, text: string) => {
    setEditorText(text);
    try {
      sessionStorage.setItem(draftKey(i), text);
    } catch {
      // storage unavailable
    }
  };

  const send = (row: EffectiveEntry) => {
    const text = editorText.trim();
    if (!text) return;
    pendingRef.current = { index: row.index, prevAmendedAt: row.amendedAt };
    setAmendingIndex(row.index);
    onAmend(row.index, text);
  };

  const n = folded.length;
  if (n === 0) return null;
  const hasRevisions = folded.some(
    (r) =>
      r.entry.qId === "revise" ||
      r.entry.qId === "confirm" ||
      r.entry.qId === "reopen"
  );

  // Shared inline amend editor (identical in both variants).
  const editorFor = (row: EffectiveEntry) => {
    const amendBusy =
      working && workingKind === "amend" && amendingIndex === row.index;
    const identical =
      !row.effectiveSkipped &&
      editorText.trim() === row.effectiveAnswer.trim();
    return (
      <form
        className="pb-4"
        onSubmit={(e) => {
          e.preventDefault();
          send(row);
        }}
      >
        <p className="max-w-none text-xs" style={faint}>
          Tell me the new answer and I will rework what it touched.
        </p>
        <textarea
          ref={textareaRef}
          className="input mt-2 w-full"
          rows={3}
          maxLength={2000}
          aria-label={`Your changed answer for: ${truncate(row.entry.q, 80)}`}
          value={editorText}
          onChange={(e) => setText(row.index, e.target.value)}
          disabled={working || featureDisabled}
        />
        <div className="mt-3 flex flex-wrap items-center gap-6">
          <button
            type="submit"
            className="btn btn--primary btn--stable"
            aria-busy={amendBusy || undefined}
            disabled={
              working ||
              featureDisabled ||
              brainDown ||
              !editorText.trim() ||
              identical
            }
          >
            <BusyLabel busy={amendBusy} idle="Send new answer" busyText="Sending" />
          </button>
          <button
            type="button"
            className="btn btn--text"
            disabled={amendBusy}
            onClick={() => setEditorIndex(null)}
          >
            Cancel
          </button>
        </div>
        {amendBusy && <WorkingRow long={workingLong} kind="amend" />}
        {brainDown && !working && <BrainDownNote />}
      </form>
    );
  };

  let qNum = 0;
  // Revision, kept-as-drafted, format, and reopen rows never consume a
  // number; amend rows are folded and never listed.
  const rowLabel = (t: TranscriptEntry) =>
    t.qId === "revise"
      ? "Revision request"
      : t.qId === "confirm"
        ? `Kept as drafted · ${t.q.replace(/^Open item: /, "")}`
        : t.qId === "restyle"
          ? "Format pass"
          : t.qId === "reopen"
            ? "Reopened for changes"
            : `Q${++qNum} · ${t.q}`;

  if (variant === "promoted") {
    const qCount = folded.filter((r) => isQuestionEntry(r.entry)).length;
    return (
      <div className="mt-6">
        <h4 className="sys-label">Your answers · {qCount}</h4>
        <p className="mt-2 max-w-none text-sm" style={dim}>
          The draft is built on these. Change one and I will rework whatever
          it touched.
        </p>
        <div
          className="transcript-scroll transcript-scroll--promoted mt-3"
          tabIndex={0}
          role="group"
          aria-label="Your answers"
        >
          {folded.map((row) => {
            const t = row.entry;
            const question = isQuestionEntry(t);
            const editing = editorIndex === row.index;
            const label = rowLabel(t);
            if (!question)
              // History rows stay visible in place but quiet: label plus, for
              // revision requests, the request text itself (it is the user's
              // content; hiding it entirely would delete it from the UI).
              return (
                <div
                  key={`${t.qId}-${row.index}`}
                  className="border-b py-2"
                  style={{ borderColor: "var(--xl-line)" }}
                >
                  <p className="max-w-none text-xs" style={faint}>
                    {label} · {fmtDate(t.answeredAt)}
                  </p>
                  {t.qId === "revise" && t.a && (
                    <p
                      className="max-w-none text-xs line-clamp-2"
                      style={faint}
                      title={t.a}
                    >
                      {t.a}
                    </p>
                  )}
                </div>
              );
            return (
              <div
                key={`${t.qId}-${row.index}`}
                className="border-b py-2"
                style={{ borderColor: "var(--xl-line)" }}
              >
                <p className="max-w-none text-sm" style={dim}>
                  {label}
                </p>
                {!editing && (
                  <p
                    className="mt-1 max-w-none text-sm line-clamp-2"
                    style={
                      row.effectiveSkipped ? dim : { color: "var(--xl-text)" }
                    }
                    title={row.effectiveSkipped ? undefined : row.effectiveAnswer}
                  >
                    {row.effectiveSkipped
                      ? "Skipped. Tron drafted a default."
                      : row.effectiveAnswer}
                  </p>
                )}
                {row.amendedAt && row.previous && (
                  <p className="max-w-none text-xs" style={faint}>
                    Changed {fmtDate(row.amendedAt)} · was:{" "}
                    {row.previous.skipped
                      ? "skipped"
                      : `"${truncate(row.previous.answer, 160)}"`}
                  </p>
                )}
                {canAmend && !editing && (
                  <p className="pb-1 text-sm">
                    <button
                      type="button"
                      ref={(el) => {
                        if (el) rowRefs.current.set(row.index, el);
                        else rowRefs.current.delete(row.index);
                      }}
                      className="linklike min-h-11"
                      disabled={working}
                      onClick={() => openEditor(row)}
                    >
                      {row.effectiveSkipped ? "Answer it now" : "Change"}
                    </button>
                  </p>
                )}
                {editing && editorFor(row)}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <details className="transcript mb-6">
      <summary className="min-h-11 cursor-pointer py-2 text-sm" style={dim}>
        {hasRevisions
          ? `Previous questions and revisions (${n})`
          : `Previous questions (${n})`}
      </summary>
      <div
        className="transcript-scroll"
        tabIndex={0}
        role="group"
        aria-label="Previous answers"
      >
        {folded.map((row) => {
          const t = row.entry;
          const question = isQuestionEntry(t);
          const editing = editorIndex === row.index;
          return (
            <details
              key={`${t.qId}-${row.index}`}
              className="border-b"
              style={{ borderColor: "var(--xl-line)" }}
            >
              <summary
                ref={(el) => {
                  if (el) rowRefs.current.set(row.index, el);
                  else rowRefs.current.delete(row.index);
                }}
                className="min-h-11 cursor-pointer py-2 text-sm"
                style={dim}
              >
                {rowLabel(t)}
                {row.amendedAt && (
                  <span style={faint}>
                    {" "}
                    · changed {fmtDate(row.amendedAt)}
                  </span>
                )}
              </summary>
              <p className="max-w-none pb-3 text-sm">
                {row.effectiveSkipped
                  ? "Skipped. Tron drafted a default."
                  : row.effectiveAnswer}
              </p>
              {row.amendedAt && row.previous && (
                <p className="max-w-none pb-3 text-xs" style={faint}>
                  Changed {fmtDate(row.amendedAt)} · was:{" "}
                  {row.previous.skipped
                    ? "skipped"
                    : `"${truncate(row.previous.answer, 160)}"`}
                </p>
              )}
              {question && canAmend && !editing && (
                <p className="pb-3 text-sm">
                  <button
                    type="button"
                    className="linklike"
                    disabled={working}
                    onClick={() => openEditor(row)}
                  >
                    {row.effectiveSkipped ? "Answer it now" : "Change this answer"}
                  </button>
                </p>
              )}
              {question && editing && editorFor(row)}
            </details>
          );
        })}
      </div>
    </details>
  );
}

function BrainDownNote() {
  return (
    <p className="mt-3 max-w-none text-sm" style={{ color: "var(--xl-warn)" }}>
      Tron&apos;s drafting engine is offline right now. Your answer is kept
      here; this page will keep checking and re-enable Send when he is back.
    </p>
  );
}

function NoticeLine({ notice }: { notice: WorkspaceNotice | null }) {
  if (!notice) return null;
  return (
    <p
      className="mt-3 max-w-none text-sm"
      style={{
        color: notice.kind === "error" ? "var(--xl-danger)" : "var(--xl-text-dim)",
      }}
    >
      {notice.text}
    </p>
  );
}

export function QuestionPane({
  view,
  projectId,
  answerText,
  onAnswerChange,
  onToggleSuggestion,
  working,
  workingKind,
  workingLong,
  brainDown,
  chaseBridge,
  restyleActive,
  restyleStopping,
  onStopRestyle,
  featureDisabled,
  notice,
  skipPending,
  onSkipRequest,
  onSkipCancel,
  onSkipConfirm,
  onSend,
  onRevise,
  onAmend,
  onConfirm,
  confirmBusy,
  onReopen,
  reopenBusy,
  onJump,
  onKeepItem,
  onSendResolved,
  onAnnounce,
  questionHeadingRef,
  reviewHeadingRef,
  downloadSlot,
}: {
  view: ProjectView;
  projectId: string;
  answerText: string;
  onAnswerChange: (text: string) => void;
  onToggleSuggestion: (suggestion: string) => void;
  working: boolean;
  workingKind: WorkingKind;
  workingLong: boolean;
  brainDown: boolean;
  chaseBridge: boolean;
  // A reformat run holds the lock across the gaps between its passes
  // (`working` briefly drops there); the pause note carries its own Stop so
  // the exit lives where the lock is felt (§5.12 auto-reformat).
  restyleActive: boolean;
  restyleStopping: boolean;
  onStopRestyle: () => void;
  featureDisabled: boolean;
  notice: WorkspaceNotice | null;
  skipPending: boolean;
  onSkipRequest: () => void;
  onSkipCancel: () => void;
  onSkipConfirm: () => void;
  onSend: () => void;
  onRevise: () => void;
  onAmend: (index: number, answer: string) => void;
  onConfirm: () => void;
  confirmBusy: boolean;
  onReopen: () => void;
  reopenBusy: boolean;
  onJump: (doc: string, section: string, focus: boolean) => void;
  onKeepItem: (item: OpenConfirmItem) => Promise<KeepResult>;
  onSendResolved: (message: string, focusSections: string[]) => void;
  onAnnounce: (text: string) => void;
  questionHeadingRef: RefObject<HTMLHeadingElement | null>;
  reviewHeadingRef: RefObject<HTMLHeadingElement | null>;
  downloadSlot: ReactNode;
}) {
  const q = view.nextQuestion;
  // ONE monotone question counter across the whole interview (owner rule
  // 2026-07-17): bank questions, follow-ups, and open-item chase questions
  // all count; the transcript numbering uses the same predicate.
  const n = questionNumber(view.transcript);
  // Open-item chase questions ("qi_" ids, owner rule 2026-07-17) ride the
  // same pane as every other question; only the context copy differs (one
  // answer can clear several open items, so markers are never a question
  // denominator). Skipping one moves the draft to review instead of
  // drafting a default.
  const chase = isChaseId(q?.id);
  const inputLocked = working || featureDisabled || restyleActive;
  // Non-advancing turns (amend/restyle) run under the same one-turn lock;
  // the question card explains the pause instead of showing a spinner row.
  // A reformat run counts for its whole span, not just while a pass is in
  // flight, so the note (and the lock) never flickers between passes.
  const restylePause = restyleActive || (working && workingKind === "restyle");
  const pausedByOther =
    restylePause || (working && workingKind === "amend");
  const sendLocked = inputLocked || brainDown;
  const segments = chipSegments(answerText);
  const sendBusy = working && workingKind === "send";
  const reviseBusy = working && workingKind === "revise";
  // The draft section this question is about; the jump link is the way to
  // reach the marked text from the Questions tab on mobile.
  const feedTarget = q ? firstFeedTarget(q.feeds, view.documents) : null;
  // Host-detected sections still holding scaffold text, titled exactly as
  // the doc pane renders them. These block confirm, and so do open
  // [TO CONFIRM] items (owner rule 2026-07-17: a final draft carries zero
  // markers; each is resolved by a typed fact or an explicit keep).
  const undrafted = Object.entries(view.placeholderSections ?? {}).flatMap(
    ([slug, secs]) => {
      const doc = view.documents.find((d) => d.slug === slug);
      if (!doc) return [];
      return secs.flatMap((sid) => {
        const si = doc.sections.findIndex((x) => x.id === sid);
        if (si < 0) return [];
        return [
          {
            doc: slug,
            section: sid,
            docTitle: doc.title,
            sectionTitle: sectionTitleText(si + 1, doc.sections[si].title),
          },
        ];
      });
    }
  );

  const bankLeft = Math.max(0, view.progress.total - view.progress.answered);
  // Foreshadow the counter's unit flip (UX review 2026-07-17): when the
  // planned bank is nearly done and open [TO CONFIRM] items remain, the chip
  // says the chase comes next, so "N open items left" never lands
  // unannounced. The bridge line below reinforces; this warns.
  const foreshadow =
    !chase && bankLeft <= 1 && view.openConfirmTotal > 0
      ? " · then the draft's open items"
      : "";
  // Review is only re-enterable through reopen (revise and non-advancing
  // turns always stay in review; there is no review -> drafting path), so a
  // reopen row in a review-status project always means THIS review session
  // follows a final. Sound permanently, not just for the first cycle.
  const reopened = view.transcript.some((t) => t.qId === "reopen");

  return (
    <section className="min-w-0">
      <h2 className="sr-only">Questions from Tron</h2>
      {/* Exactly ONE TranscriptList instance (shared sessionStorage keys):
          the quiet disclosure in drafting AND done, the promoted "Your
          answers" block inside the review panel in review. */}
      {view.status !== "review" && (
        <TranscriptList
          view={view}
          projectId={projectId}
          working={working}
          workingKind={workingKind}
          workingLong={workingLong}
          brainDown={brainDown}
          featureDisabled={featureDisabled}
          onAmend={onAmend}
          variant="quiet"
        />
      )}

      {view.status === "drafting" && q && (
        <div className="panel panel--lightline">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="sys-label">
              Question {String(n).padStart(2, "0")}
            </span>
            <span className="text-xs" style={faint}>
              {chase
                ? `${view.openConfirmTotal} open ${view.openConfirmTotal === 1 ? "item" : "items"} left · one answer can clear several`
                : q.bankId === null
                  ? bankLeft > 0
                    ? `a follow-up · about ${bankLeft} to go${foreshadow}`
                    : `a follow-up${foreshadow}`
                  : `about ${bankLeft} to go${foreshadow}`}
            </span>
          </div>
          {chase && chaseBridge && (
            <p
              id="chase-bridge-note"
              className="mt-1 max-w-none text-xs"
              style={faint}
            >
              My planned questions are done; the ones from here clear the open{" "}
              <mark className="doc-confirm">[TO CONFIRM]</mark> items in the
              draft, so this count is open items, not questions.
            </p>
          )}
          <h3
            ref={questionHeadingRef}
            tabIndex={-1}
            className="doc-h mt-4 text-lg"
            aria-describedby={
              chase && chaseBridge ? "chase-bridge-note" : undefined
            }
          >
            {q.text}
          </h3>
          {q.why && (
            <p className="mt-2 max-w-none text-sm" style={dim}>
              {q.why}
            </p>
          )}
          {/* Background-check question (q.snapshot): the object of review is
              Tron's research understanding, rendered HERE in the card. The
              ask-anchor choreography and jump link are suppressed for this
              question (an unrelated section's markers misled the owner). */}
          {q.snapshot && (
            <div className="q-snapshot">
              <span className="sys-label sys-label--warn">
                {view.companySnapshot
                  ? "Research · unconfirmed"
                  : "Research · nothing found"}
              </span>
              {view.companySnapshot ? (
                <>
                  <dl>
                    {(view.companySnapshot.profile ||
                      view.companySnapshot.name) && (
                      <>
                        <dt>Who I think you are</dt>
                        <dd className="max-w-none">
                          {view.companySnapshot.name &&
                          view.companySnapshot.profile
                            ? `${view.companySnapshot.name} · ${view.companySnapshot.profile}`
                            : view.companySnapshot.name ||
                              view.companySnapshot.profile}
                        </dd>
                      </>
                    )}
                    {view.companySnapshot.size && (
                      <>
                        <dt>Size and footprint</dt>
                        <dd className="max-w-none">
                          {view.companySnapshot.size}
                        </dd>
                      </>
                    )}
                    {view.companySnapshot.industry && (
                      <>
                        <dt>Industry</dt>
                        <dd className="max-w-none">
                          {view.companySnapshot.industry}
                        </dd>
                      </>
                    )}
                  </dl>
                  <p className="mt-2 max-w-none text-xs" style={faint}>
                    This is from public sources, not fact. Your answer below
                    overrides all of it.
                  </p>
                </>
              ) : (
                <p className="mt-2 max-w-none text-sm">
                  Honest answer: I could not research much about you from
                  public sources, so this check is on you. Tell me in your own
                  words: what you do, roughly how big you are, and what
                  industry you are in.
                </p>
              )}
            </div>
          )}
          {feedTarget && !q.snapshot && (
            <p className="mt-3 max-w-none text-sm">
              <button
                type="button"
                className="linklike"
                onClick={() => onJump(feedTarget.doc, feedTarget.section, true)}
              >
                See the text this is about
              </button>
            </p>
          )}
          {/* Chips (and their hint) hide when the snapshot came up empty:
              "Yes, that matches" is nonsense with nothing shown to match. */}
          {q.suggestions.length > 0 && !(q.snapshot && !view.companySnapshot) && (
            <>
              <p className="mt-4 max-w-none text-xs" style={faint}>
                Tap to add or remove. Combine them or edit below.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {q.suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="gov-chip"
                    aria-pressed={segments.includes(chipCanon(s))}
                    disabled={inputLocked}
                    onClick={() => onToggleSuggestion(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </>
          )}

          <form
            className="answer-sticky mt-6 pt-2"
            onSubmit={(e) => {
              e.preventDefault();
              onSend();
            }}
          >
            <textarea
              className="input w-full"
              rows={4}
              maxLength={2000}
              placeholder="Plain words are fine. I draft; you steer."
              aria-label="Your answer"
              value={answerText}
              onChange={(e) => onAnswerChange(e.target.value)}
              disabled={inputLocked}
            />
            <div className="mt-4 flex flex-wrap items-center gap-6">
              <button
                type="submit"
                className="btn btn--primary btn--stable"
                aria-busy={sendBusy || undefined}
                disabled={sendLocked || !answerText.trim()}
              >
                <BusyLabel busy={sendBusy} idle="Send answer" busyText="Sending" />
              </button>
              <button
                type="button"
                className="btn btn--text"
                disabled={sendLocked}
                onClick={onSkipRequest}
              >
                Skip this question
              </button>
            </div>
            {skipPending && !working && (
              <div className="mt-3 text-xs" style={faint}>
                <p className="max-w-none">
                  {chase
                    ? "Skipping moves the draft to review. The remaining open items stay listed there for you to resolve."
                    : "Skipped. I will draft a sensible default you can change later."}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-6">
                  <button
                    type="button"
                    className="btn btn--text"
                    onClick={onSkipConfirm}
                  >
                    Confirm skip
                  </button>
                  <button
                    type="button"
                    className="btn btn--text"
                    onClick={onSkipCancel}
                  >
                    Keep answering
                  </button>
                </div>
              </div>
            )}
            {working && !pausedByOther && (
              <WorkingRow long={workingLong} kind={workingKind} />
            )}
            {pausedByOther && (
              <div className="mt-3 text-sm" style={dim}>
                <p className="max-w-none">
                  {restylePause
                    ? "Paused while I reformat the draft to match your sample. Answering comes back when it finishes, or stop it and finish the rest later."
                    : "Paused while I rework an earlier answer. This question is not going anywhere."}
                </p>
                {restylePause && (
                  <button
                    type="button"
                    className="btn btn--text mt-2"
                    disabled={restyleStopping}
                    aria-busy={restyleStopping || undefined}
                    onClick={onStopRestyle}
                  >
                    {restyleStopping ? "Stopping..." : "Stop reformatting"}
                  </button>
                )}
              </div>
            )}
            {brainDown && !working && <BrainDownNote />}
            <NoticeLine notice={notice} />
          </form>
        </div>
      )}

      {view.status === "review" && (
        <div className="panel panel--lightline-sand">
          <span className="sys-label sys-label--sand">Review</span>
          <h3 ref={reviewHeadingRef} tabIndex={-1} className="mt-4">
            {view.openConfirmTotal > 0
              ? "Almost there: open items need you"
              : reopened
                ? "Back in review"
                : "That is everything I need"}
          </h3>
          <p className="mt-3 max-w-none text-sm">
            {remapLegacyReopenedSummary(view.reviewSummary) ||
              REVIEW_DEFAULT_COPY}
          </p>

          {undrafted.length > 0 && (
            <div className="mt-5">
              <p className="text-sm">
                <strong>Sections not yet drafted ({undrafted.length})</strong>
              </p>
              <ul className="mt-2 space-y-2">
                {undrafted.map((it) => (
                  <li key={`${it.doc}:${it.section}`} className="text-sm">
                    <button
                      type="button"
                      className="linklike"
                      onClick={() => onJump(it.doc, it.section, true)}
                    >
                      {it.docTitle + " · " + it.sectionTitle}
                    </button>
                  </li>
                ))}
              </ul>
              <p className="mt-2 max-w-none text-xs" style={faint}>
                These still hold planning text, so confirming is off until
                they are drafted.{" "}
                <button
                  type="button"
                  className="linklike"
                  disabled={inputLocked}
                  onClick={() =>
                    onAnswerChange(
                      "Draft all sections that are still marked as not yet drafted."
                    )
                  }
                >
                  Ask Tron to draft them all
                </button>{" "}
                fills the box below; edit it or send it as is.
              </p>
            </div>
          )}

          <OpenItemsResolver
            projectId={view.id}
            items={view.openConfirmItems}
            total={view.openConfirmTotal ?? view.openConfirmItems.length}
            documents={view.documents}
            status={view.status}
            rev={view.rev}
            working={working}
            workingKind={workingKind}
            workingLong={workingLong}
            brainDown={brainDown}
            featureDisabled={featureDisabled}
            onJump={onJump}
            onKeep={onKeepItem}
            onSendAnswers={onSendResolved}
            onAnnounce={onAnnounce}
          />

          <TranscriptList
            view={view}
            projectId={projectId}
            working={working}
            workingKind={workingKind}
            workingLong={workingLong}
            brainDown={brainDown}
            featureDisabled={featureDisabled}
            onAmend={onAmend}
            variant="promoted"
            fallbackFocusRef={reviewHeadingRef}
          />

          <form
            className="mt-6"
            onSubmit={(e) => {
              e.preventDefault();
              onRevise();
            }}
          >
            <p className="max-w-none text-sm" style={dim}>
              Something else off in the text itself? Ask here and I will
              revise the draft.
            </p>
            <textarea
              className="input mt-2 w-full"
              rows={3}
              maxLength={2000}
              placeholder="Ask for any change to the wording or content, in plain words."
              aria-label="Revision request"
              value={answerText}
              onChange={(e) => onAnswerChange(e.target.value)}
              disabled={inputLocked}
            />
            <button
              type="submit"
              className="btn btn--stable mt-4"
              aria-busy={reviseBusy || undefined}
              disabled={sendLocked || !answerText.trim()}
            >
              <BusyLabel
                busy={reviseBusy}
                idle="Revise the draft"
                busyText="Revising"
              />
            </button>
            {working &&
              workingKind !== "resolve" &&
              !pausedByOther && (
                <WorkingRow long={workingLong} kind={workingKind} />
              )}
            {pausedByOther && (
              <div className="mt-3 text-sm" style={dim}>
                <p className="max-w-none">
                  {restylePause
                    ? "Paused while I reformat the draft to match your sample. Revising comes back when it finishes, or stop it and finish the rest later."
                    : "Paused while I rework an earlier answer. The draft updates when it lands."}
                </p>
                {restylePause && (
                  <button
                    type="button"
                    className="btn btn--text mt-2"
                    disabled={restyleStopping}
                    aria-busy={restyleStopping || undefined}
                    onClick={onStopRestyle}
                  >
                    {restyleStopping ? "Stopping..." : "Stop reformatting"}
                  </button>
                )}
              </div>
            )}
            {brainDown && !working && <BrainDownNote />}
            <NoticeLine notice={notice} />
          </form>

          <hr className="rule" style={{ margin: "var(--sp-6) 0" }} />
          {(view.openConfirmTotal ?? view.openConfirmItems.length) > 0 && (
            <p className="mb-3 max-w-none text-xs" style={faint}>
              {(() => {
                const n = view.openConfirmTotal ?? view.openConfirmItems.length;
                return `Confirming is off until the ${n} open ${n === 1 ? "item" : "items"} above ${n === 1 ? "is" : "are"} resolved. Each one is a fact I assumed for you, and a final draft should carry none of my assumptions.`;
              })()}
            </p>
          )}
          <button
            type="button"
            className="btn btn--sand btn--stable"
            aria-busy={confirmBusy || undefined}
            disabled={working || restyleActive || confirmBusy || featureDisabled}
            onClick={onConfirm}
          >
            <BusyLabel
              busy={confirmBusy}
              idle="Confirm final draft"
              busyText="Confirming"
            />
          </button>
          <p className="mt-3 max-w-none text-xs" style={faint}>
            {reopened
              ? "Confirming makes this final again and takes the draft watermark off downloads."
              : `Confirming marks the project final: downloads lose the DRAFT watermark. If something changes later, reopen it from this page any time before it auto-deletes on ${fmtDate(view.deletesAt)}.`}
          </p>
        </div>
      )}

      {view.status === "done" && (
        <div className="panel panel--raised">
          <span className="sys-label sys-label--sand">Final</span>
          <h3 className="mt-4">Final draft saved</h3>
          <p className="mt-3 max-w-none text-sm">
            Download it now and keep it wherever you keep policies. This
            project auto-deletes {fmtDate(view.deletesAt)}; the deadline is
            ours, not yours.
          </p>
          <div className="mt-6">{downloadSlot}</div>
          <hr className="rule" style={{ margin: "var(--sp-6) 0" }} />
          <p className="text-sm">Need to change something?</p>
          <button
            type="button"
            className="btn btn--stable mt-3"
            aria-busy={reopenBusy || undefined}
            disabled={reopenBusy || featureDisabled}
            onClick={onReopen}
          >
            <BusyLabel busy={reopenBusy} idle="Reopen for changes" busyText="Reopening" />
          </button>
          <p className="mt-3 max-w-none text-xs" style={faint}>
            Reopening puts the draft back in review. The text stays exactly as
            it is; downloads carry the DRAFT watermark again until you confirm
            final.
          </p>
          <NoticeLine notice={notice} />
        </div>
      )}
    </section>
  );
}
