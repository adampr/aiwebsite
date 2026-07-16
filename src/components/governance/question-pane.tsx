"use client";

// Left column of the workspace: prior Q&A transcript, the current question
// card + answer form (drafting), the review panel (review), and the final
// panel (done). Errors here are visual text only; announcements go through
// the workspace's single polite live region.

import type { ReactNode, RefObject } from "react";
import type { ProjectView } from "@/lib/governance/types";
import { sectionTitleText } from "@/lib/governance/numbering";
import { chipCanon, chipSegments, firstFeedTarget, fmtDate } from "./shared";

const faint = { color: "var(--xl-text-faint)" } as const;
const dim = { color: "var(--xl-text-dim)" } as const;

export interface WorkspaceNotice {
  kind: "info" | "error";
  text: string;
}

/** Which action is in flight; picks the busy copy for the status row. */
export type WorkingKind = "send" | "skip" | "revise";

/** Stable-width busy button: both labels are stacked in the same grid
 *  cell so the swap never shifts neighbouring controls. */
function BusyLabel({
  busy,
  idle,
  busyText,
}: {
  busy: boolean;
  idle: string;
  busyText: string;
}) {
  return (
    <>
      <span className="btn-swap" aria-hidden={busy ? true : undefined}>
        {idle}
      </span>
      <span className="btn-swap" aria-hidden={busy ? undefined : true}>
        {busyText}
        <span className="dot" aria-hidden="true" />
      </span>
    </>
  );
}

const REVIEW_DEFAULT_COPY =
  "No more questions. Read the draft on the right. If something reads wrong, tell me below and I will revise it. When it reads right, confirm it and take it with you.";

/** One collapsed disclosure for the whole Q&A history: the current question
 *  card stays the top anchor of the column no matter how many answers
 *  accumulate, and the list scrolls itself once opened. Uncontrolled and
 *  unkeyed so the open state survives turn re-renders. */
function TranscriptList({ view }: { view: ProjectView }) {
  const n = view.transcript.length;
  if (n === 0) return null;
  const hasRevisions = view.transcript.some((t) => t.qId === "revise");
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
        {view.transcript.map((t, i) => (
          <details
            key={`${t.qId}-${i}`}
            className="border-b"
            style={{ borderColor: "var(--xl-line)" }}
          >
            <summary
              className="min-h-11 cursor-pointer py-2 text-sm"
              style={dim}
            >
              {/* Revision rows never consume a question number. */}
              {t.qId === "revise" ? "Revision request" : `Q${++qNum} · ${t.q}`}
            </summary>
            <p className="max-w-none pb-3 text-sm">
              {t.skipped ? "Skipped. Tron drafted a default." : t.a}
            </p>
          </details>
        ))}
      </div>
    </details>
  );
}

function WorkingRow({ long, kind }: { long: boolean; kind: WorkingKind }) {
  const base =
    kind === "skip"
      ? "Skipped. Drafting a sensible default."
      : kind === "revise"
        ? "On it. Revising the draft."
        : "Got it. Folding your answer into the draft.";
  const more = !long
    ? " This can take a little while."
    : kind === "skip"
      ? " Still working."
      : " Still working. Longer answers take longer.";
  return (
    <div className="mt-4">
      <div className="working-rule" aria-hidden="true" />
      <div className="mt-3 flex items-center gap-3 text-sm" style={dim}>
        <span
          className="dot shrink-0"
          style={{ color: "var(--xl-light)" }}
          aria-hidden="true"
        />
        <span>{base + more}</span>
      </div>
    </div>
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
  answerText,
  onAnswerChange,
  onToggleSuggestion,
  working,
  workingKind,
  workingLong,
  brainDown,
  featureDisabled,
  notice,
  skipPending,
  onSkipRequest,
  onSkipCancel,
  onSkipConfirm,
  onSend,
  onRevise,
  onConfirm,
  confirmBusy,
  onJump,
  questionHeadingRef,
  reviewHeadingRef,
  downloadSlot,
}: {
  view: ProjectView;
  answerText: string;
  onAnswerChange: (text: string) => void;
  onToggleSuggestion: (suggestion: string) => void;
  working: boolean;
  workingKind: WorkingKind;
  workingLong: boolean;
  brainDown: boolean;
  featureDisabled: boolean;
  notice: WorkspaceNotice | null;
  skipPending: boolean;
  onSkipRequest: () => void;
  onSkipCancel: () => void;
  onSkipConfirm: () => void;
  onSend: () => void;
  onRevise: () => void;
  onConfirm: () => void;
  confirmBusy: boolean;
  onJump: (doc: string, section: string, focus: boolean) => void;
  questionHeadingRef: RefObject<HTMLHeadingElement | null>;
  reviewHeadingRef: RefObject<HTMLHeadingElement | null>;
  downloadSlot: ReactNode;
}) {
  const q = view.nextQuestion;
  const n = view.progress.answered + 1;
  const inputLocked = working || featureDisabled;
  const sendLocked = inputLocked || brainDown;
  const segments = chipSegments(answerText);
  const sendBusy = working && workingKind === "send";
  const reviseBusy = working && workingKind === "revise";
  // The draft section this question is about; the jump link is the way to
  // reach the marked text from the Questions tab on mobile.
  const feedTarget = q ? firstFeedTarget(q.feeds, view.documents) : null;
  // Host-detected sections still holding scaffold text, titled exactly as
  // the doc pane renders them. These block confirm; open [TO CONFIRM]
  // items intentionally do not (unverified facts are the user's to accept,
  // undrafted sections are not content at all).
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

  return (
    <section className="min-w-0">
      <h2 className="sr-only">Questions from Tron</h2>
      <TranscriptList view={view} />

      {view.status === "drafting" && q && (
        <div className="panel panel--lightline">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="sys-label">
              Question {String(n).padStart(2, "0")}
            </span>
            <span className="text-xs" style={faint}>
              question {n} of about {view.progress.total}
            </span>
          </div>
          <h3 ref={questionHeadingRef} tabIndex={-1} className="doc-h mt-4 text-lg">
            {q.text}
          </h3>
          {q.why && (
            <p className="mt-2 max-w-none text-sm" style={dim}>
              {q.why}
            </p>
          )}
          {feedTarget && (
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
          {q.suggestions.length > 0 && (
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
                  Skipped. I will draft a sensible default you can change
                  later.
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
            {working && <WorkingRow long={workingLong} kind={workingKind} />}
            {brainDown && !working && <BrainDownNote />}
            <NoticeLine notice={notice} />
          </form>
        </div>
      )}

      {view.status === "review" && (
        <div className="panel panel--lightline-sand">
          <span className="sys-label sys-label--sand">Review</span>
          <h3 ref={reviewHeadingRef} tabIndex={-1} className="mt-4">
            That is everything I need
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

          {view.openConfirmItems.length > 0 && (
            <div className="mt-5">
              <p className="text-sm">
                <strong>
                  Open items to confirm ({view.openConfirmItems.length})
                </strong>
              </p>
              <ul className="mt-2 space-y-2">
                {view.openConfirmItems.map((it, i) => (
                  <li key={`${it.doc}:${it.section}:${i}`} className="text-sm">
                    <button
                      type="button"
                      className="linklike"
                      onClick={() => onJump(it.doc, it.section, true)}
                    >
                      {(view.documents.find((d) => d.slug === it.doc)?.title ??
                        it.doc) + " · " + it.excerpt}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

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
            {working && <WorkingRow long={workingLong} kind={workingKind} />}
            {brainDown && !working && <BrainDownNote />}
            <NoticeLine notice={notice} />
          </form>

          <hr className="rule" style={{ margin: "var(--sp-6) 0" }} />
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
