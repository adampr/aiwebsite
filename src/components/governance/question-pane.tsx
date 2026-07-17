"use client";

// Left column of the workspace: prior Q&A transcript, the current question
// card + answer form (drafting), the review panel (review), and the final
// panel (done). Errors here are visual text only; announcements go through
// the workspace's single polite live region.

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { OpenConfirmItem, ProjectView } from "@/lib/governance/types";
import {
  foldTranscript,
  isQuestionEntry,
  questionNumber,
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
  "No more questions. Read the draft on the right. If something reads wrong, tell me below and I will revise it. When it reads right and every open item is resolved, confirm it and take it with you.";

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(" ");
  return (sp > n / 2 ? cut.slice(0, sp) : cut) + "...";
}

/** One collapsed disclosure for the whole Q&A history: the current question
 *  card stays the top anchor of the column no matter how many answers
 *  accumulate, and the list scrolls itself once opened. Uncontrolled and
 *  unkeyed so the open state survives turn re-renders.
 *
 *  Amend rows are FOLDED into the question row they correct (interview.ts):
 *  each question shows its latest effective answer plus a "was" line, and a
 *  "Change this answer" editor sends a non-advancing amend turn. Question
 *  numbering uses the same isQuestionEntry predicate as the header counter,
 *  so the two can never disagree. */
function TranscriptList({
  view,
  projectId,
  working,
  workingKind,
  workingLong,
  brainDown,
  featureDisabled,
  onAmend,
}: {
  view: ProjectView;
  projectId: string;
  working: boolean;
  workingKind: WorkingKind;
  workingLong: boolean;
  brainDown: boolean;
  featureDisabled: boolean;
  onAmend: (index: number, answer: string) => void;
}) {
  const [editorIndex, setEditorIndex] = useState<number | null>(null);
  const [editorText, setEditorText] = useState("");
  // The in-flight amend: ref for effect logic, state mirror for render (the
  // lint rule forbids ref reads during render). prevAmendedAt lets a landed
  // turn (which appends an amend row and moves amendedAt) be told apart
  // from a failed one.
  const pendingRef = useRef<{ index: number; prevAmendedAt: string | null } | null>(null);
  const [amendingIndex, setAmendingIndex] = useState<number | null>(null);
  const summaryRefs = useRef(new Map<number, HTMLElement>());
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
      window.requestAnimationFrame(() =>
        summaryRefs.current.get(p.index)?.focus()
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
    (r) => r.entry.qId === "revise" || r.entry.qId === "confirm"
  );
  let qNum = 0;
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
          const amendBusy =
            working && workingKind === "amend" && amendingIndex === row.index;
          const identical =
            !row.effectiveSkipped && editorText.trim() === row.effectiveAnswer.trim();
          return (
            <details
              key={`${t.qId}-${row.index}`}
              className="border-b"
              style={{ borderColor: "var(--xl-line)" }}
            >
              <summary
                ref={(el) => {
                  if (el) summaryRefs.current.set(row.index, el);
                  else summaryRefs.current.delete(row.index);
                }}
                className="min-h-11 cursor-pointer py-2 text-sm"
                style={dim}
              >
                {/* Revision, kept-as-drafted, and format rows never consume
                    a number; amend rows are folded and never listed. */}
                {t.qId === "revise"
                  ? "Revision request"
                  : t.qId === "confirm"
                    ? `Kept as drafted · ${t.q.replace(/^Open item: /, "")}`
                    : t.qId === "restyle"
                      ? "Format pass"
                      : `Q${++qNum} · ${t.q}`}
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
              {question && editing && (
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
                    aria-label={`Your changed answer for: ${truncate(t.q, 80)}`}
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
                      <BusyLabel
                        busy={amendBusy}
                        idle="Send new answer"
                        busyText="Sending"
                      />
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
              )}
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
  const chase = !!q && q.id.startsWith("qi_");
  const inputLocked = working || featureDisabled;
  // Non-advancing turns (amend/restyle) run under the same one-turn lock;
  // the question card explains the pause instead of showing a spinner row.
  const pausedByOther =
    working && (workingKind === "amend" || workingKind === "restyle");
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

  return (
    <section className="min-w-0">
      <h2 className="sr-only">Questions from Tron</h2>
      <TranscriptList
        view={view}
        projectId={projectId}
        working={working}
        workingKind={workingKind}
        workingLong={workingLong}
        brainDown={brainDown}
        featureDisabled={featureDisabled}
        onAmend={onAmend}
      />

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
                    ? `a follow-up · about ${bankLeft} to go`
                    : "a follow-up"
                  : `about ${bankLeft} to go`}
            </span>
          </div>
          {chase && chaseBridge && (
            <p className="mt-3 max-w-none text-sm" style={dim}>
              The planned questions are done. The questions from here target
              the assumptions still marked [TO CONFIRM] in the draft, so the
              count above is open items, not questions.
            </p>
          )}
          <h3 ref={questionHeadingRef} tabIndex={-1} className="doc-h mt-4 text-lg">
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
              <p className="mt-3 max-w-none text-sm" style={dim}>
                {workingKind === "amend"
                  ? "Paused while I rework an earlier answer. This question is not going anywhere."
                  : "Paused while I reformat the draft to match your sample. This question is not going anywhere."}
              </p>
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
              : "That is everything I need"}
          </h3>
          <p className="mt-3 max-w-none text-sm">
            {view.reviewSummary || REVIEW_DEFAULT_COPY}
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

          <form
            className="mt-6"
            onSubmit={(e) => {
              e.preventDefault();
              onRevise();
            }}
          >
            <textarea
              className="input w-full"
              rows={3}
              maxLength={2000}
              placeholder="Ask for any change, in plain words."
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
              <p className="mt-3 max-w-none text-sm" style={dim}>
                {workingKind === "amend"
                  ? "Paused while I rework an earlier answer. The draft updates when it lands."
                  : "Paused while I reformat the draft to match your sample."}
              </p>
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
            disabled={working || confirmBusy || featureDisabled}
            onClick={onConfirm}
          >
            <BusyLabel
              busy={confirmBusy}
              idle="Confirm final draft"
              busyText="Confirming"
            />
          </button>
          <p className="mt-3 max-w-none text-xs" style={faint}>
            Confirming locks the draft and marks the project final. You can
            still download it until it auto-deletes on {fmtDate(view.deletesAt)}.
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
        </div>
      )}
    </section>
  );
}
