// Interview accounting shared by the client workspace and server writes
// (§5.12). Client-safe: pure functions over types only (view.ts is NOT
// client-safe; it transitively imports node fs via db.ts).

import type { TranscriptEntry } from "./types";

/**
 * A transcript row that consumed a question: real question ids are "q_<rev>"
 * (bank/model questions) or "qi_<rev>" (host open-item chase questions),
 * including skipped ones. Excludes "revise", "confirm", "restyle", and
 * "amend" rows by construction. This predicate is THE definition of the
 * monotonic question counter (owner rule 2026-07-17): the question card
 * header and the transcript numbering both derive from it, so they can
 * never disagree.
 */
export function isQuestionEntry(t: TranscriptEntry): boolean {
  return /^qi?_/.test(t.qId);
}

/** Host-synthesized open-item chase question ("qi_<rev>"). THE definition
 * for client copy that varies by phase (counter chip, bridge line): both
 * derive from this one predicate so they can never drift apart. */
export function isChaseId(id: string | null | undefined): id is string {
  return !!id && id.startsWith("qi_");
}

/** Bank-check switch card ("qs_<rev>", §5.12): the research-pause question
 * offering the FFIEC offering to a detected bank. Deliberately NOT matched
 * by isQuestionEntry: its transcript row never consumes a question number
 * (the interview has not started when it is asked). */
export function isSwitchId(id: string | null | undefined): id is string {
  return !!id && id.startsWith("qs_");
}

/** The CURRENT question's number: questions asked so far + 1. */
export function questionNumber(transcript: TranscriptEntry[]): number {
  return transcript.filter(isQuestionEntry).length + 1;
}

/** Round 15 (2026-07-17): the review panel renamed "Previous questions" to
 * the promoted "Your answers" block. Reopened projects store their summary
 * at reopen time (reopen route writes REVIEW_REOPENED_SUMMARY), so rows
 * reopened before this release still carry the old wording, possibly with an
 * appended open-items note (withOpenItemsNote). The prefix remap keeps that
 * suffix. Client-side only (stored drafts age out on 30-day retention);
 * REOPENED_SUMMARY_CURRENT is pinned equal to config's
 * REVIEW_REOPENED_SUMMARY by governance-tests. */
const REOPENED_SUMMARY_LEGACY =
  "Reopened. Change any answer under Previous questions, ask for any change in the box below, or confirm again to make it final as is.";
export const REOPENED_SUMMARY_CURRENT =
  "Reopened. Change any answer under Your answers below, ask for any other change in the box under them, or confirm again to make it final as is.";
export function remapLegacyReopenedSummary(
  summary: string | null
): string | null {
  if (summary && summary.startsWith(REOPENED_SUMMARY_LEGACY))
    return (
      REOPENED_SUMMARY_CURRENT + summary.slice(REOPENED_SUMMARY_LEGACY.length)
    );
  return summary;
}

/**
 * Folded transcript view for display: amend rows collapse into the question
 * row they correct, so the list shows one row per question with its LATEST
 * effective answer plus a "was" annotation. Amend rows never render as list
 * rows and never consume a question number.
 */
export interface EffectiveEntry {
  entry: TranscriptEntry;
  index: number; // index into the raw transcript (amend target address)
  effectiveAnswer: string; // latest amend's answer, else the original
  effectiveSkipped: boolean; // false once an amend answered a skipped row
  amendedAt: string | null; // ISO of the latest amend, null if never amended
  // What the latest amend replaced (one step of history is enough).
  previous: { skipped: boolean; answer: string } | null;
}

export function foldTranscript(transcript: TranscriptEntry[]): EffectiveEntry[] {
  const out: EffectiveEntry[] = [];
  const byIndex = new Map<number, EffectiveEntry>();
  transcript.forEach((t, i) => {
    if (t.qId === "amend" && typeof t.amendsIndex === "number") {
      const target = byIndex.get(t.amendsIndex);
      if (target) {
        target.previous = {
          skipped: target.effectiveSkipped,
          answer: target.effectiveAnswer,
        };
        target.effectiveAnswer = t.a;
        target.effectiveSkipped = false;
        target.amendedAt = t.answeredAt;
      }
      return; // amend rows are folded, never listed
    }
    const row: EffectiveEntry = {
      entry: t,
      index: i,
      effectiveAnswer: t.a,
      effectiveSkipped: t.skipped,
      amendedAt: null,
      previous: null,
    };
    byIndex.set(i, row);
    out.push(row);
  });
  return out;
}
