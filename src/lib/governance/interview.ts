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

/** The CURRENT question's number: questions asked so far + 1. */
export function questionNumber(transcript: TranscriptEntry[]): number {
  return transcript.filter(isQuestionEntry).length + 1;
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
