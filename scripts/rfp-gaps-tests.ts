/**
 * Gap-question vocabulary tests (ARCHITECTURE.md §5.17.2).
 *
 *   npm run test:rfpgaps
 *
 * Pure, no server. Pins the 2026-08-27 B-O-F incident class: one
 * co-managed-IT question minted under four wordings across eight sections,
 * answered three times. normalizeGapQuestion is the ONE definition of
 * "same question" for both the client queue dedupe and the server snap;
 * these tests pin that the snap always yields raw text the exact-match
 * machinery (client dedupe + gap-route lookup) merges.
 */

import {
  capOpenQuestionsForPrompt,
  collectOpenQuestions,
  normalizeGapQuestion,
  OPEN_QUESTIONS_PROMPT_MAX,
  snapGapQuestions,
} from "../src/lib/rfp/gaps";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `\n     got ${a}\n     want ${e}`}`
  );
}

// ---- normalizer: byte-identical to the old workspace.tsx inline ------------

check(
  "lowercase + punctuation folding",
  normalizeGapQuestion("Does XL.net offer Co-Managed IT?"),
  "does xl net offer co managed it"
);
check(
  "whitespace runs fold",
  normalizeGapQuestion("co   managed\n\tIT"),
  "co managed it"
);
check(
  "curly quotes and unicode punctuation strip",
  normalizeGapQuestion("client’s “co-managed” IT?"),
  "client s co managed it"
);
check("symbol-only collapses to empty", normalizeGapQuestion("??? -- !"), "");
check("empty string", normalizeGapQuestion(""), "");
// The client-parity pin: the shared function must stay byte-identical to the
// historical workspace inline, or gaps stored on live proposals re-key.
for (const q of [
  "Does XL.net offer co-managed IT?",
  "- Does X?",
  "  MIXED   Case,   punct!!  ",
  "Line one\nline two?",
]) {
  check(
    `parity pin: ${JSON.stringify(q)}`,
    normalizeGapQuestion(q),
    q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
  );
}

// ---- collectOpenQuestions --------------------------------------------------

const sections = [
  { label: "1", gaps: [{ question: "Q one?" }] },
  { label: "2", gaps: [{ question: "q ONE!" }, { question: "Q two?" }] },
  { label: "3", gaps: [{ question: "Q three, own wording?" }] },
  { label: "__letter", gaps: [{ question: "never me" }] },
];

check(
  "doc order, first-wins dedupe, letter skipped, own gaps last",
  collectOpenQuestions(sections, "3"),
  ["Q one?", "Q two?", "Q three, own wording?"]
);
check(
  "other section's wording outranks the target's own duplicate",
  collectOpenQuestions(
    [
      { label: "A", gaps: [{ question: "Shared, a wording?" }] },
      { label: "B", gaps: [{ question: "SHARED a wording" }] },
    ],
    "A"
  ),
  ["SHARED a wording"]
);
check(
  "brand-new section (no own record) collects the others",
  collectOpenQuestions(sections, "9"),
  ["Q one?", "Q two?", "Q three, own wording?"]
);
check("empty proposal", collectOpenQuestions([], "1"), []);
check(
  "a __ target label never contributes its own gaps",
  collectOpenQuestions(
    [{ label: "__future", gaps: [{ question: "furniture?" }] }],
    "__future"
  ),
  []
);

// ---- capOpenQuestionsForPrompt ---------------------------------------------

check(
  "count cap",
  capOpenQuestionsForPrompt(Array.from({ length: 20 }, (_, i) => `q${i}`))
    .length,
  OPEN_QUESTIONS_PROMPT_MAX
);
check(
  "char budget stops before overflow, never truncates an item",
  capOpenQuestionsForPrompt([
    "a".repeat(2500),
    "b".repeat(2500),
    "c".repeat(2500),
  ]),
  ["a".repeat(2500), "b".repeat(2500)]
);
check("cap of empty", capOpenQuestionsForPrompt([]), []);
check(
  "reserveTail admits the trailing own gaps before the head fills the cap",
  capOpenQuestionsForPrompt(
    [...Array.from({ length: 14 }, (_, i) => `other${i}`), "own1", "own2"],
    2
  ),
  [...Array.from({ length: 10 }, (_, i) => `other${i}`), "own1", "own2"]
);
check(
  "reserveTail of zero is byte-identical to the plain cap",
  capOpenQuestionsForPrompt(
    Array.from({ length: 20 }, (_, i) => `q${i}`),
    0
  ),
  capOpenQuestionsForPrompt(Array.from({ length: 20 }, (_, i) => `q${i}`))
);

// ---- prompt-line discipline roundtrip --------------------------------------
// The generate route's landing snap must fold a prompt-line echo back onto
// the stored raw. draftSection renders lines with angle runs and whitespace
// runs mapped to a SPACE; both transforms are normalize-invariant, so the
// echo always normalize-equals the raw. Pins the refuter finding: an
// empty-string angle strip ("a<<<b" -> "ab") would break this.
{
  const raw = "Does the client need A<<<B integration,\nor separate systems?";
  const promptLine = raw
    .replace(/<{3,}|>{3,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  check(
    "angle-run + multi-line prompt echo snaps back onto the stored raw",
    snapGapQuestions([{ question: promptLine, why: "w" }], [raw]),
    [{ question: raw, why: "w" }]
  );
}

// ---- snapGapQuestions ------------------------------------------------------

check(
  "paraphrase snaps to the open question's exact raw text, why preserved",
  snapGapQuestions(
    [{ question: "does XL.NET offer co-managed IT!?", why: "w" }],
    ["Does XL.net offer co-managed IT?"]
  ),
  [{ question: "Does XL.net offer co-managed IT?", why: "w" }]
);
check(
  "whitespace-collapsed prompt echo snaps back to the multi-line stored raw",
  snapGapQuestions(
    [{ question: "Line one line two?", why: "w" }],
    ["Line one\nline two?"]
  ),
  [{ question: "Line one\nline two?", why: "w" }]
);
check(
  "bullet-prefixed echo of a prompt line snaps back to the stored raw",
  snapGapQuestions(
    [{ question: "- Does XL.net offer co-managed IT?", why: "w" }],
    ["Does XL.net offer co-managed IT?"]
  ),
  [{ question: "Does XL.net offer co-managed IT?", why: "w" }]
);
check(
  "genuinely new question passes through untouched",
  snapGapQuestions([{ question: "Brand new ask?", why: "w" }], [
    "Old question?",
  ]),
  [{ question: "Brand new ask?", why: "w" }]
);
check(
  "two returned gaps that normalize equal fold to one (first wins)",
  snapGapQuestions(
    [
      { question: "Same thing?", why: "a" },
      { question: "same THING!", why: "b" },
    ],
    []
  ),
  [{ question: "Same thing?", why: "a" }]
);
check(
  "precedence: first open wording wins when the list holds two variants",
  snapGapQuestions(
    [{ question: "shared a wording??", why: "w" }],
    ["SHARED a wording", "Shared, a wording?"]
  ),
  [{ question: "SHARED a wording", why: "w" }]
);
check(
  "snap of empty gaps is a no-op (the letter path)",
  snapGapQuestions([], ["Open?"]),
  []
);
check(
  "identical raw text is returned as-is",
  snapGapQuestions([{ question: "Exact?", why: "w" }], ["Exact?"]),
  [{ question: "Exact?", why: "w" }]
);
check(
  "symbol-only candidate never snaps and is stored as-is",
  snapGapQuestions([{ question: "???", why: "w" }], ["Real question?"]),
  [{ question: "???", why: "w" }]
);

if (failures) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log("\nall passing");
