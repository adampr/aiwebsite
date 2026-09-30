// The client-side twin of references-ask.ts's isReferencesGapQuestion
// (ARCHITECTURE.md §5.17.2).
//
// references-ask.ts carries lookbehind regexes and the whole ask scanner, so
// the workspace client does not import it. This module is the one thing the
// client needs from it: "is this THE references question?", answered from
// the canonical text's fixed shape. scripts/rfp-references-tests.ts pins the
// two against each other at every count, so a reworded canonical question
// fails the tests instead of silently showing the remember box again.
//
// PURE and client-safe: no imports beyond gaps.ts, no lookbehind.
//
// The server stays the authority. The gap route forces `remember` off for
// the canonical question AND for any model-worded references question, no
// matter what the client sends; this predicate only decides what the answer
// box shows.

import { normalizeGapQuestion } from "./gaps";

const CANONICAL_SHAPE =
  /^the rfp asks for (?:(?:one|two|three|four|five|six|seven|eight|nine|ten) )?client references? which clients? should be listed and what contact name title phone and email should appear(?: for each)?$/;

/** True for the canonical references gap question at any count. */
export function isCanonicalReferencesQuestion(question: string): boolean {
  return CANONICAL_SHAPE.test(normalizeGapQuestion(question));
}

/** Number word for a references count, as the canonical question words it. */
export function referencesCountWord(count: number | null): string | null {
  const words = [
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
  ];
  return count !== null && Number.isInteger(count) && count >= 1 && count <= 10
    ? words[count - 1]
    : null;
}
