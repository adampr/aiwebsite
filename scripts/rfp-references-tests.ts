/**
 * References backstop tests (ARCHITECTURE.md §5.17.2).
 *
 *   npm run test:rfprefs
 *
 * Pure, no server. Pins the 2026-09-30 incident: an RFP asked "Provide two
 * references for similar work", the drafter answered every other ask, and
 * the section landed with no mention of references and no open question.
 * Every organization below is invented; real reference names live only in
 * the database and must never appear in a test.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collectOpenQuestions, snapGapQuestions } from "../src/lib/rfp/gaps";
import {
  asksAboutReferences,
  isReferencesGapQuestion,
  isReferencesRefusal,
  rankReferenceCandidates,
  REFERENCE_ETIQUETTE_SENTENCE,
  REFERENCES_GAP_QUESTION,
  referencesAsk,
  referencesGapWhy,
  sectionMentionsReferences,
  sectionPresentsReferences,
  unansweredReferencesAsks,
  withReferenceEtiquette,
  withReferencesGap,
} from "../src/lib/rfp/references-ask";
import {
  isCanonicalReferencesQuestion,
  referencesCountWord,
} from "../src/lib/rfp/references-question";

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

// ---- detection: the asks that must fire ------------------------------------

const count = (text: string) => {
  const found = referencesAsk([text]);
  return found ? found.count : "none";
};
const fires = (text: string) => referencesAsk([text]) !== null;

check("the incident text", count("Provide two references for similar work."), 2);
check("word plus parenthesized digit", count("Submit three (3) client references."), 3);
check("digit", count("Include 3 references from current customers"), 3);
check("at least N", count("Provide at least five professional references."), 5);
check("range takes the minimum", count("List three to five references."), 3);
check(
  "count after a heading",
  count("References: list at least 3 clients of similar size."),
  3
);
check("heading with a parenthesized count", count("References (2)"), 2);
check("bare heading", count("References"), null);
check("verb, no count", count("Please provide client references."), null);
check(
  "contact details FOR references",
  count("Provide contact information for references."),
  null
);
check(
  "references from similar organizations",
  count("Proposals should contain references from similar organizations."),
  null
);
check("one reference", count("Provide at least one reference."), 1);
check("a number past ten is an ask with no count", count("Provide 15 references."), null);
check(
  "a duration after the noun is not a count",
  count("Provide references from the past five years."),
  null
);
check(
  "a counted requirement beats an earlier uncounted one",
  referencesAsk(["Provide client references.", "Two references are required."]),
  { count: 2, requirement: "Two references are required." }
);

// ---- detection: the senses that must NOT fire -------------------------------

for (const text of [
  "Include the RFP reference number on every page.",
  "A copy of the policy is attached for reference.",
  "Meet the requirements referenced above.",
  "Respond to the Terms of Reference in Appendix A.",
  "Describe your reference architecture for backups.",
  "Provide one reference architecture diagram.",
  "Include references to applicable NIST standards.",
  "The agreement is incorporated by reference.",
  "Describe two years of experience and how you cross-reference tickets.",
  "Vendor consents to reference checks.",
  "Describe your help desk hours and escalation path.",
  "Use this document as a point of reference.",
  "Describe your preference for onsite visits.",
])
  check(`no ask: ${text}`, fires(text), false);
check("no requirements", referencesAsk([]), null);

// ---- the canonical question -------------------------------------------------

check(
  "two",
  REFERENCES_GAP_QUESTION(2),
  "The RFP asks for two client references. Which clients should be listed, and what contact name, title, phone and email should appear for each?"
);
check(
  "one is singular throughout",
  REFERENCES_GAP_QUESTION(1),
  "The RFP asks for one client reference. Which client should be listed, and what contact name, title, phone and email should appear?"
);
check(
  "no count",
  REFERENCES_GAP_QUESTION(null),
  "The RFP asks for client references. Which clients should be listed, and what contact name, title, phone and email should appear for each?"
);
check("out of range falls back to no count", REFERENCES_GAP_QUESTION(40), REFERENCES_GAP_QUESTION(null));
check("stable per count", REFERENCES_GAP_QUESTION(3), REFERENCES_GAP_QUESTION(3));
for (const n of [null, 1, 2, 7, 10]) {
  check(`recognized at count ${n}`, isReferencesGapQuestion(REFERENCES_GAP_QUESTION(n)), true);
  check(`no em dash at count ${n}`, REFERENCES_GAP_QUESTION(n).includes("—"), false);
}
check(
  "a collapsed echo is still recognized",
  isReferencesGapQuestion(REFERENCES_GAP_QUESTION(2).toLowerCase().replace(/[?.,]/g, "")),
  true
);
check("another question is not", isReferencesGapQuestion("Does XL.net offer co-managed IT?"), false);
// The client twin (references-question.ts) must agree with the server's
// canonical test at every count: the workspace uses it to hide the remember
// box, and a reworded canonical question has to fail here.
for (const n of [null, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
  const q = REFERENCES_GAP_QUESTION(n);
  check(`client twin recognizes count ${n}`, isCanonicalReferencesQuestion(q), true);
  if (n !== null)
    check(`client twin count word ${n}`, q.includes(` ${referencesCountWord(n)} client reference`), true);
}
check("client twin: count word out of range", referencesCountWord(40), null);
for (const q of [
  "Does XL.net offer co-managed IT?",
  "Which two clients can serve as references?",
  "Do technicians supply references from past employers?",
])
  check(`client twin agrees on: ${q}`, isCanonicalReferencesQuestion(q), isReferencesGapQuestion(q));
check(
  "a model-worded references question counts as about references",
  asksAboutReferences("Which two clients can serve as references?"),
  true
);
check("an unrelated question does not", asksAboutReferences("What is the reference number?"), false);

// ---- mentions vs presents ---------------------------------------------------

check("mention", sectionMentionsReferences(["We list two references below."]), true);
check("no mention", sectionMentionsReferences(["Support is answered live.", "For reference, see 4.2."]), false);
check(
  "presented",
  sectionPresentsReferences([
    "Our references are Acme Clinic, Jane Roe, Executive Director, 555-0100, jane@acme.example.",
  ]),
  true
);
check(
  "a deferral presents nothing",
  sectionPresentsReferences(["References are available on request.", "We will provide references at interview."]),
  false
);
check("the etiquette alone presents nothing", sectionPresentsReferences([REFERENCE_ETIQUETTE_SENTENCE]), false);
check("silence presents nothing", sectionPresentsReferences(["Eleven paragraphs about everything else."]), false);

// ---- the backstop -----------------------------------------------------------

const ask = referencesAsk(["Provide two references for similar work."]);
const base = { ask, paragraphs: ["Everything else."], otherSections: [], openQuestions: [], why: "W" };
const canon = { question: REFERENCES_GAP_QUESTION(2), why: "W" };

check("the incident: zero gaps becomes the one question", withReferencesGap([], base), [canon]);
check(
  "guaranteed a slot beside two model gaps",
  withReferencesGap([{ question: "A?", why: "a" }, { question: "B?", why: "b" }], base),
  [{ question: "A?", why: "a" }, { question: "B?", why: "b" }, canon]
);
check(
  "a model-worded references gap is replaced, never kept beside it",
  withReferencesGap([{ question: "Which clients can we list as references?", why: "m" }], base),
  [canon]
);
check("no ask, no change", withReferencesGap([], { ...base, ask: null }), []);
check(
  "a section that presents references needs no question",
  withReferencesGap([], { ...base, paragraphs: ["Our two references are Acme Clinic and Birch School."] }),
  []
);
check(
  "nor when another section presents them",
  withReferencesGap([], { ...base, otherSections: [["x"], ["Our references are Acme Clinic and Birch School."]] }),
  []
);
check(
  "a deferral in the draft does not count as an answer",
  withReferencesGap([], { ...base, paragraphs: ["References are available on request."] }),
  [canon]
);
check(
  "an open references question is reused byte for byte, even at another count",
  withReferencesGap([], { ...base, openQuestions: ["Other?", REFERENCES_GAP_QUESTION(3)] }),
  [{ question: REFERENCES_GAP_QUESTION(3), why: "W" }]
);
// Dedupe/snap invariant: the appended gap merges with the same question open
// on another section, as one queue entry.
{
  const sections = [
    { label: "3", gaps: [{ question: REFERENCES_GAP_QUESTION(2) }] },
    { label: "6", gaps: [] },
  ];
  const open = collectOpenQuestions(sections, "6");
  const landed = snapGapQuestions(withReferencesGap([], { ...base, openQuestions: open }), open);
  check("lands as the open question's exact text", landed, [canon]);
  check(
    "and the proposal still has ONE distinct question",
    collectOpenQuestions([sections[0], { label: "6", gaps: landed }], "").length,
    1
  );
}

// ---- why: what the knowledge base holds -------------------------------------

const held = [
  { organization: "Acme Freight", segment: "export and logistics", relationshipSince: "2014", usableWithoutAsking: false, hasContact: false },
  { organization: "Birch Clinic", segment: "nonprofit healthcare", relationshipSince: "June 2010", usableWithoutAsking: false, hasContact: false },
  { organization: "Cedar School", segment: "education", relationshipSince: null, usableWithoutAsking: false, hasContact: false },
];
check(
  "segment ranking: the RFP's own sector first, stable otherwise",
  rankReferenceCandidates(held, "Wellness, NFP is a not-for-profit behavioral health care provider.").map((c) => c.organization),
  ["Birch Clinic", "Acme Freight", "Cedar School"]
);
check(
  "why states the ask, the holdings and the shortlist",
  referencesGapWhy(ask!, held, "a nonprofit clinic"),
  'The RFP asks: "Provide two references for similar work."\nThe knowledge base holds 3 client references, none with contact details on file and none cleared to use without asking the client first.\nClosest by segment: Birch Clinic (nonprofit healthcare, client since June 2010); Acme Freight (export and logistics, client since 2014); Cedar School (education).\nNothing about references is written until this is answered. Type each organization, contact name, title, phone and email here; details on file are not filled in for you.'
);
check(
  "an empty knowledge base says so",
  referencesGapWhy(ask!, [], ""),
  'The RFP asks: "Provide two references for similar work."\nThe knowledge base holds no client references.\nNothing about references is written until this is answered. Type each organization, contact name, title, phone and email here; details on file are not filled in for you.'
);
check(
  "a failed read still yields a why",
  referencesGapWhy(ask!, null, ""),
  'The RFP asks: "Provide two references for similar work."\nNothing about references is written until this is answered. Type each organization, contact name, title, phone and email here; details on file are not filled in for you.'
);
{
  const many = Array.from({ length: 40 }, (_, i) => ({
    ...held[0],
    organization: `Org ${i} ${"x".repeat(200)}`,
  }));
  const why = referencesGapWhy(ask!, many, "");
  check("why is bounded", why.length <= 1000, true);
  check("why never carries an em dash", why.includes("—"), false);
}

// ---- read-time twin ---------------------------------------------------------

const reqs = [
  { structureLabel: "5.", text: "Describe your help desk." },
  { structureLabel: "6.", text: "Provide two references for similar work." },
];
check(
  "the live miss: drafted, no mention, no gap",
  unansweredReferencesAsks(reqs, [
    { label: "5.", paragraphs: ["Help desk."], gaps: [] },
    { label: "6.", paragraphs: ["Everything else."], gaps: [] },
    { label: "__letter", paragraphs: ["Letter."], gaps: [] },
  ]),
  [{ label: "6.", count: 2, requirement: "Provide two references for similar work." }]
);
check(
  "quiet once the question is open",
  unansweredReferencesAsks(reqs, [
    { label: "6.", paragraphs: ["Everything else."], gaps: [{ question: REFERENCES_GAP_QUESTION(2) }] },
  ]),
  []
);
check(
  "quiet once references are presented",
  unansweredReferencesAsks(reqs, [{ label: "6.", paragraphs: ["Our references are Acme Clinic and Birch School."], gaps: [] }]),
  []
);
check("an undrafted section is not a miss", unansweredReferencesAsks(reqs, []), []);

// ---- rule D3 etiquette ------------------------------------------------------

check(
  "the sentence is D3's own suggestion, verbatim",
  readFileSync(join(process.cwd(), "src/lib/rfp/validators/rules-d.ts"), "utf8").includes(
    `"${REFERENCE_ETIQUETTE_SENTENCE}"`
  ),
  true
);
check(
  "and satisfies D3's test",
  /final step before contract/i.test(REFERENCE_ETIQUETTE_SENTENCE),
  true
);
check(
  "appended when the woven section names references",
  withReferenceEtiquette(["Our references are Acme Clinic and Birch School."], "Other sections."),
  ["Our references are Acme Clinic and Birch School.", REFERENCE_ETIQUETTE_SENTENCE]
);
check(
  "not repeated when another section already states it",
  withReferenceEtiquette(["Our references are Acme Clinic."], `Intro. ${REFERENCE_ETIQUETTE_SENTENCE}`),
  ["Our references are Acme Clinic."]
);
check(
  "not repeated when the weave wrote it itself",
  withReferenceEtiquette(["Our references are Acme Clinic. References are called as a final step before contract."], ""),
  ["Our references are Acme Clinic. References are called as a final step before contract."]
);
check(
  "untouched when the weave names no references",
  withReferenceEtiquette(["The answer declined to list any clients."], ""),
  ["The answer declined to list any clients."]
);

// ---- refuter round: detection ------------------------------------------------

// The count binds to the references noun, never to a neighbor.
check("3 years of financials is not 3 references", count("Provide 3 years of financials and references."), null);
check("two copies is not two references", count("Provide two (2) copies and references."), null);

// False negatives closed.
check("heading, dash, count", count("References - three required"), 3);
check("letters of reference", count("Provide three letters of reference."), 3);
check("letters of reference, no count", count("Provide letters of reference."), null);
check("reference list with a minimum", count("Reference list (minimum 3)"), 3);
check("reference list of N clients", count("Reference list of 3 clients"), 3);
check("a client reference is one", count("Provide a client reference."), 1);
check("a bare singular is still prose", fires("Keep a reference for later."), false);

check(
  "a condition is not a negation",
  count("Proposals that do not include three references will be rejected."),
  3
);

// Negations and other people's references.
for (const text of [
  "Do not include references.",
  "No references are required at this stage.",
  "References are not required.",
  "Provide proof of insurance. References: none required.",
  "Include page references for each answer.",
  "Include section references in your response.",
  "The contractor shall provide employee references upon hire.",
  "See the 2 references in Appendix B for network diagrams.",
  "Describe how you cross-reference and list cross-references.",
  "List 5 engineers and their references.",
  "Vendor shall submit resumes and references for key personnel.",
  "Bibliography and references cited",
  "Each ticket references the affected asset.",
])
  check(`no ask: ${text}`, fires(text), false);

// The section title is part of the ask.
check(
  "a references title alone is an ask, quoted as a title",
  referencesAsk(["Describe your experience with similar clients."], "6. References"),
  { count: null, requirement: "6. References", fromTitle: true }
);
check(
  "under a references title, a counted list of clients carries the count",
  referencesAsk(
    ["List two current clients of similar size with contact name, phone and email."],
    "References"
  ),
  { count: 2, requirement: "List two current clients of similar size with contact name, phone and email." }
);
check(
  "without that title the same sentence is not an ask",
  referencesAsk(["List two current clients of similar size with contact name, phone and email."]),
  null
);
check(
  "a counted requirement beats the title",
  referencesAsk(["Provide three references."], "Experience and References"),
  { count: 3, requirement: "Provide three references." }
);
check(
  "a counted title beats an uncounted requirement",
  referencesAsk(["Please provide client references."], "References (2)"),
  { count: 2, requirement: "References (2)", fromTitle: true }
);
check(
  "a requirement that refuses references silences the title",
  referencesAsk(["No references are required at this stage."], "References"),
  null
);
check("a title in another sense is nothing", referencesAsk(["Describe the network."], "Reference Architecture"), null);
check("a title about staff references is nothing", referencesAsk([], "Employee References"), null);
check(
  "why reads sensibly when the match is the title",
  referencesGapWhy({ count: null, requirement: "6. References", fromTitle: true }, null, ""),
  'The RFP has a section titled "6. References".\nNothing about references is written until this is answered. Type each organization, contact name, title, phone and email here; details on file are not filled in for you.'
);

// ---- refuter round: presenting needs POSITIVE evidence -------------------------

for (const text of [
  "Each ticket references the affected asset.",
  "This section references the onboarding approach described in Section 4.",
  "We use the CIS benchmarks as a reference.",
  "XL.net's quick reference card is given to every user.",
  "Our engineers maintain reference documentation for every client.",
  "We check references for every technician we hire.",
  "Please see the references section.",
  "References will be supplied at the finalist stage.",
  "XL.net does not provide client references at the proposal stage.",
  "Client references: to follow.",
  "Client references are included in Appendix B.",
  "XL.net has provided the requested references.",
  "XL.net will provide three client references.",
  "Our clients serve as references for this work.",
  "We would be delighted to arrange reference calls after selection.",
])
  check(`presents nothing: ${text}`, sectionPresentsReferences([text]), false);

check(
  "a labeled list presents",
  sectionPresentsReferences(["Client references: Example Org (Jane Roe, Director) and Sample Co (John Doe, CFO)."]),
  true
);
check(
  "a references sentence with a contact token presents",
  sectionPresentsReferences(["The following reference may be contacted. Example Org, Jane Roe, Director, (312) 555-0100."]),
  true
);
check(
  "the contact line may be the next paragraph",
  sectionPresentsReferences(["We offer the following references.", "Example Org, Jane Roe, jane@example.org"]),
  true
);
check(
  "a contact token beside a deferral presents nothing",
  sectionPresentsReferences(["References are available on request; call (312) 555-0100."]),
  false
);
check(
  "the backstop still fires when another section only uses the verb",
  withReferencesGap([], { ...base, otherSections: [["Each ticket references the affected asset."]] }),
  [canon]
);
check(
  "and when this section uses the idiom",
  withReferencesGap([], { ...base, paragraphs: ["We serve nonprofits and use CIS as a reference."] }),
  [canon]
);
check(
  "an answered stamp on another section counts as presenting",
  withReferencesGap([], { ...base, answeredElsewhere: true }),
  []
);
check(
  "the read-time twin honors the stamp",
  unansweredReferencesAsks(reqs, [
    { label: "5.", paragraphs: ["Example Org and Sample Co."], gaps: [], referencesAnswered: true },
    { label: "6.", paragraphs: ["Everything else."], gaps: [] },
  ]),
  []
);
check(
  "the read-time twin reads the title",
  unansweredReferencesAsks([], [{ label: "7.", title: "References", paragraphs: ["Everything else."], gaps: [] }]),
  [{ label: "7.", count: null, requirement: "References" }]
);

// ---- refuter round: only a which-references gap is replaced --------------------

{
  const other = { question: "Do technicians supply references from past employers?", why: "m" };
  check("a question in another sense is not about references", asksAboutReferences(other.question), false);
  check("nor is the verb", asksAboutReferences("Which ticket references the outage?"), false);
  check("nor is the idiom", asksAboutReferences("Should we cite NIST as a reference?"), false);
  check("a which-references question is", asksAboutReferences("Which references should we list?"), true);
  check(
    "an unrelated gap that uses the word is kept beside the canonical one",
    withReferencesGap([other], base),
    [other, canon]
  );
  check("and is not the canonical question", isReferencesGapQuestion(other.question), false);
  check(
    "a model-worded which-references question is not canonical either",
    isReferencesGapQuestion("Which clients can we list as references?"),
    false
  );
}

// ---- refuter round: etiquette after the references question --------------------

const ANSWERED = { answered: true } as const;
check(
  "appended even when the weave never uses the word",
  withReferenceEtiquette(["Example Org: Jane Roe, Director, 555-0100."], "6\nClients\nOther text.", ANSWERED),
  ["Example Org: Jane Roe, Director, 555-0100.", REFERENCE_ETIQUETTE_SENTENCE]
);
check(
  "exactly once: not again when any record already states it",
  withReferenceEtiquette(["Sample Co: John Doe."], `3\nReferences\nExample Org.\n${REFERENCE_ETIQUETTE_SENTENCE}`, ANSWERED),
  ["Sample Co: John Doe."]
);
check(
  "not again when the letter states it in its own words",
  withReferenceEtiquette(
    ["Our references are Example Org."],
    "__letter\nCover letter\nOut of respect for our clients' time, references are contacted last.",
    ANSWERED
  ),
  ["Our references are Example Org."]
);
check(
  "idempotent",
  withReferenceEtiquette(
    withReferenceEtiquette(["Our references are Example Org."], "", ANSWERED),
    "",
    ANSWERED
  ).length,
  2
);
check("a refusal is recognized", isReferencesRefusal("We will not provide references for this proposal."), true);
check("none is a refusal", isReferencesRefusal("None."), true);
check("an answer is not", isReferencesRefusal("Example Org, Jane Roe, 555-0100; no title on file."), false);
check(
  "a refusal that leaves the word nowhere adds nothing",
  withReferenceEtiquette(["We support nonprofits."], "6\nClients", { answered: true, refusal: true }),
  ["We support nonprofits."]
);
check(
  "a refusal woven with the word still gets the sentence (D3 would block)",
  withReferenceEtiquette(["XL.net will not provide references for this proposal."], "", {
    answered: true,
    refusal: true,
  }),
  ["XL.net will not provide references for this proposal.", REFERENCE_ETIQUETTE_SENTENCE]
);
check(
  "as does a refusal under a References title",
  withReferenceEtiquette(["We decline at this stage."], "6\nReferences", { answered: true, refusal: true }),
  ["We decline at this stage.", REFERENCE_ETIQUETTE_SENTENCE]
);

if (failures) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log("\nall passing");
