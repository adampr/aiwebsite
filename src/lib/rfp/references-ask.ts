// The references backstop (ARCHITECTURE.md §5.17.2).
//
// An RFP's request for client references must never be silently dropped.
// The drafter cannot answer it: references are not facts, they live in
// rfp_references, which no prompt ever sees, and their contact columns are
// third-party PII that ships NULL. Under the drafter's "omit the claim, most
// sections need ZERO gaps" discipline the ask simply vanished (owner,
// 2026-09-30: "This RFP requested 2 references, which you did not include").
//
// So the control is deterministic, not a prompt hope: the generate route
// detects the ask in the section's title and requirement texts and, when the
// landed text does not present references, appends ONE canonical question whose
// `why` shows what the knowledge base holds. The answer path appends rule
// D3's etiquette sentence, so an answered question cannot land a BLOCK.
//
// PURE module: no server imports, no db, no node builtins, so the tests run
// with no server. SERVER-SIDE ONLY all the same: it carries lookbehind
// regexes and the whole ask scanner, so client components import the tiny
// references-question.ts instead (the tests pin the two together).

import { PARAGRAPH_CAP } from "./draft-blocks";
import { normalizeGapQuestion } from "./gaps";
import { REFERENCES_INTRO_SENTENCE } from "./references-block";

export type ReferencesAsk = {
  /** How many the RFP asked for, 1..10, or null when it named no number. */
  count: number | null;
  /** The requirement text that carries the ask, as the reader stored it
   *  (the section title when only the title carries it). */
  requirement: string;
  /** Present and true only when the ask was read off the section TITLE. */
  fromTitle?: true;
};

const NUMBER_WORDS = [
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
] as const;
const NUM = `(?:${NUMBER_WORDS.join("|")}|\\d{1,2})`;

function toCount(token: string | undefined): number | null {
  if (!token) return null;
  const t = token.toLowerCase();
  const word = NUMBER_WORDS.indexOf(t as (typeof NUMBER_WORDS)[number]);
  const n = word >= 0 ? word + 1 : /^\d{1,2}$/.test(t) ? Number(t) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : null;
}

// What may sit between a count and the noun: "three (3) client references",
// "two recent professional references". An allowlist, because a free
// "{0,3} words" window turns "two years of experience and references" into
// a count of two.
const ADJ =
  "(?:client|customer|professional|business|trade|vendor|current|recent|relevant|similar|comparable|written|verifiable|organizational|past|prior|former|additional|separate|different|distinct|nonprofit|non-profit)";

// "two", "3", "three (3)", "at least three", "three to five", "3 or more":
// anchored to the END of the text before the noun. Group 1 is the leading
// number, group 2 the parenthesized digit when present.
const COUNT_BEFORE = new RegExp(
  `\\b(${NUM})\\b(?:\\s*\\(\\s*(\\d{1,2})\\s*\\))?` +
    `(?:\\s*(?:to|or|-)\\s*(?:${NUM}|more)\\b)?` +
    `(?:\\s+${ADJ})*\\s*$`
);

// "References: list at least 3 ...", "references (3)". Never a duration or
// a page count ("references from the past five years" has no match here
// because the number does not follow the noun directly).
const COUNT_AFTER = new RegExp(
  `^\\s*[:(,\\-–]?\\s*(?:(?:list|provide|include|submit|supply)\\s+)?` +
    `(?:(?:at least|a minimum of|minimum of|minimum)\\s+)?\\(?\\s*(${NUM})\\b` +
    `(?!\\s*(?:years?|months?|days?|weeks?|pages?|points?|pts|%))`
);

// "Reference list (minimum 3)", "reference list of 3 clients".
const LIST_AFTER = /^\s+lists?\b/;
const COUNT_AFTER_LIST = new RegExp(
  `^\\s+lists?\\s*(?:[:(]|of\\b)?\\s*` +
    `(?:(?:a\\s+)?(?:minimum|min\\.?|at least)\\s*(?:of\\s+)?)?(${NUM})\\b` +
    `(?!\\s*(?:years?|months?|days?|weeks?|pages?|points?|pts|%))`
);

// "Provide three letters of reference."
const LETTERS = new RegExp(
  `(?:\\b(${NUM})\\b(?:\\s*\\(\\s*(\\d{1,2})\\s*\\))?\\s+(?:${ADJ}\\s+)*)?` +
    `\\bletters?\\s+of\\s+(?:reference|recommendation)\\b`
);

// Under a section TITLED references, a requirement need not repeat the noun:
// "List two current clients of similar size with contact name, phone and
// email."
const CLIENTS_COUNT = new RegExp(
  `\\b(${NUM})\\b(?:\\s*\\(\\s*(\\d{1,2})\\s*\\))?\\s+(?:${ADJ}\\s+)*` +
    `(?:clients|customers|organi[sz]ations|contacts)\\b`
);

// The noun in a sense that is not a client reference: "for reference",
// "by reference", "terms of reference", "point of reference",
// "cross-reference".
const NOT_BEFORE = /(?:\b(?:for|by|terms of|points? of|frame of)\s+|\bcross[\s-]*)$/;
// Someone else's references, or a citation: "page references", "employee
// references upon hire", "engineers and their references", "bibliography
// and references".
const NOT_CLIENT_BEFORE =
  /\b(?:page|section|employee|employment|personnel|staff|character|bibliographic|technical|their|his|her|bibliograph\w*\s+and)\s+$/;
const NOT_CLIENT_AFTER =
  /^\s+(?:cited\b|sections?\b|(?:in|to)\s+(?:the\s+)?(?:appendix|section|attachment|exhibit)\b|(?:for|of)\s+(?:(?:all|each|every|key|proposed)\s+)?(?:personnel|staff|employees?|technicians?|engineers?|team\s+members?|new\s+hires?)\b|upon\s+hire\b|from\s+(?:past|previous|prior|former)\s+employers?\b)/;
// A plural followed by a determiner is the VERB: "each ticket references
// the affected asset".
const VERB_USE = /^\s+(?:the|a|an|this|these|those|each|every|its)\s/;
// The ask is negated: "do not include references", "no references are
// required", "references are not required", "References: none required".
// A relative clause is a condition, not a negation: "proposals that do not
// include three references will be rejected" asks for three.
const NEGATED_BEFORE =
  /(?<!\b(?:that|which|who)\s)\b(?:do not|don[’']t|does not|need not|not required to|no need to|without)\s+(?:\w+\s+){0,5}$|\bno\s+(?:\w+\s+)?$/;
const NEGATED_AFTER =
  /^\s*(?:(?:are|is)\s+not\b|not\s+(?:required|needed|necessary|requested)\b|[:\-–]\s*(?:none|not\s+required|n\/a)\b)/;
// "reference number", "reference architecture", "references to the
// standard", "referenced above" never reaches here (the noun match is
// word-bounded).
const NOT_AFTER =
  /^[\s-]*(?:numbers?|no\.|#|ids?\b|codes?\b|architectures?|materials?|documents?|documentation|guides?|manuals?|models?|designs?|implementations?|points?\b|data\b|standards?|librar(?:y|ies)|only\b|purposes?|checks?\b|to\b)/;

const QUALIFIER_BEFORE = /\b(?:client|customer|professional|business|trade|vendor)\s+$/;
// An ask verb governing the noun inside the same clause.
const VERB_BEFORE =
  /\b(?:provide|list|include|submit|supply|furnish|attach|identify|give|share|name)\b[^.;:]{0,48}$/;
const SOURCE_AFTER =
  /^\s+(?:from|for)\s+(?:(?:at least|a minimum of)\s+)?(?:\w+\s+){0,2}?(?:clients?|customers?|organi[sz]ations?|similar|comparable|current|past|previous|other)\b/;
// A heading-style requirement: "References", "References:", "References (3)".
const HEADING_AFTER = /^\s*(?:[:(\-–]|$)/;
// "a client reference": the singular, with a qualifier, governed by an ask
// verb, is a request for one.
const ONE_BEFORE = new RegExp(`\\b(?:a|an)\\s+(?:${ADJ}\\s+)*$`);

type NounHit = { before: string; after: string; plural: boolean };

/** Every occurrence of the noun in a client-reference-capable sense. */
function nounHits(text: string): NounHit[] {
  const t = text.replace(/\s+/g, " ").toLowerCase();
  const out: NounHit[] = [];
  for (const m of t.matchAll(/\breferences?\b/g)) {
    const at = m.index ?? 0;
    const before = t.slice(0, at);
    const after = t.slice(at + m[0].length);
    const plural = m[0].endsWith("s");
    // "for references" IS an ask ("contact details for references"); only
    // the singular reads as the idiom.
    if (NOT_BEFORE.test(before) && !(plural && /\bfor\s+$/.test(before)))
      continue;
    if (NOT_AFTER.test(after)) continue;
    if (NOT_CLIENT_BEFORE.test(before) || NOT_CLIENT_AFTER.test(after)) continue;
    if (plural && VERB_USE.test(after)) continue;
    if (NEGATED_BEFORE.test(before) || NEGATED_AFTER.test(after)) continue;
    out.push({ before, after, plural });
  }
  return out;
}

/** The text says references are NOT wanted. */
function negatesReferences(text: string): boolean {
  const t = text.replace(/\s+/g, " ").toLowerCase();
  for (const m of t.matchAll(/\breferences?\b/g)) {
    const at = m.index ?? 0;
    if (
      NEGATED_BEFORE.test(t.slice(0, at)) ||
      NEGATED_AFTER.test(t.slice(at + m[0].length))
    )
      return true;
  }
  return false;
}

function askIn(text: string): { count: number | null } | null {
  const letters = LETTERS.exec(text.replace(/\s+/g, " ").toLowerCase());
  if (letters) return { count: toCount(letters[2]) ?? toCount(letters[1]) };
  for (const hit of nounHits(text)) {
    // The count binds to the NOUN: only a number (and listed adjectives)
    // directly in front of it counts. "3 years of financials and
    // references" is an ask with no count.
    const counted = COUNT_BEFORE.exec(hit.before);
    if (counted) {
      // "three (3)": the parenthesized digit is the explicit one. A number
      // outside 1..10 is still an ask, with no count to state.
      return { count: toCount(counted[2]) ?? toCount(counted[1]) };
    }
    if (LIST_AFTER.test(hit.after))
      return { count: toCount(COUNT_AFTER_LIST.exec(hit.after)?.[1]) };
    if (
      !hit.plural &&
      ONE_BEFORE.test(hit.before) &&
      QUALIFIER_BEFORE.test(hit.before) &&
      VERB_BEFORE.test(hit.before)
    )
      return { count: 1 };
    // Otherwise only the PLURAL is an ask: "a reference" alone is prose
    // far more often than a request.
    if (!hit.plural) continue;
    const leading = /^[\s\d.()\-*•]*$/.test(hit.before);
    if (
      QUALIFIER_BEFORE.test(hit.before) ||
      VERB_BEFORE.test(hit.before) ||
      SOURCE_AFTER.test(hit.after) ||
      (leading && HEADING_AFTER.test(hit.after))
    ) {
      const after = COUNT_AFTER.exec(hit.after);
      return { count: toCount(after?.[1]) };
    }
  }
  return null;
}

/**
 * Does this section ask for client references?
 *
 * Precision over recall: a false positive interrupts a person with a
 * question the RFP never asked. The first requirement that STATES A COUNT
 * wins; otherwise the first that asks at all.
 *
 * `title` is the section's own title. An RFP often carries the ask there
 * and nowhere else ("6. References", with requirements that only describe
 * what to list), so a title that names references is an ask by itself, and
 * under it a requirement may state the count without the noun ("List two
 * current clients ... with contact name, phone and email"). A requirement
 * that says references are NOT wanted silences the title.
 */
export function referencesAsk(
  requirements: string[],
  title?: string
): ReferencesAsk | null {
  const titled =
    title && nounHits(title).some((h) => h.plural) ? title.trim() : null;
  const titleAsk = titled ? (askIn(titled) ?? { count: null }) : null;
  let uncounted: ReferencesAsk | null = null;
  let negated = false;
  for (const requirement of requirements) {
    let ask = askIn(requirement);
    if (!ask && titleAsk) {
      const clients = CLIENTS_COUNT.exec(
        requirement.replace(/\s+/g, " ").toLowerCase()
      );
      if (clients)
        ask = { count: toCount(clients[2]) ?? toCount(clients[1]) };
    }
    if (!ask) {
      negated ||= negatesReferences(requirement);
      continue;
    }
    if (ask.count !== null) return { count: ask.count, requirement };
    uncounted ??= { count: null, requirement };
  }
  if (titled && titleAsk && titleAsk.count !== null)
    return { count: titleAsk.count, requirement: titled, fromTitle: true };
  if (uncounted) return uncounted;
  if (titled && titleAsk && !negated)
    return { count: null, requirement: titled, fromTitle: true };
  return null;
}

const QUESTION_TAIL =
  "Which clients should be listed, and what contact name, title, phone and email should appear for each?";

/**
 * THE question, one stable text per count. Gap questions merge by
 * normalized exact text (gaps.ts), so every section that carries the ask
 * must mint these exact bytes: changing this wording re-keys questions
 * already stored on live proposals. It deliberately names no client: the
 * question text is fed back into later draft prompts as an open question,
 * and the candidates belong in `why`, which never is.
 */
export function REFERENCES_GAP_QUESTION(count: number | null): string {
  const n =
    count !== null && Number.isInteger(count) && count >= 1 && count <= 10
      ? count
      : null;
  if (n === 1)
    return "The RFP asks for one client reference. Which client should be listed, and what contact name, title, phone and email should appear?";
  return n === null
    ? `The RFP asks for client references. ${QUESTION_TAIL}`
    : `The RFP asks for ${NUMBER_WORDS[n - 1]} client references. ${QUESTION_TAIL}`;
}

const CANONICAL = new Set(
  [null, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) =>
    normalizeGapQuestion(REFERENCES_GAP_QUESTION(n))
  )
);

/** True for the canonical question at any count (normalized compare). */
export function isReferencesGapQuestion(question: string): boolean {
  return CANONICAL.has(normalizeGapQuestion(question));
}

const OTHER_PEOPLE =
  /\b(?:employers?|technicians?|employees?|engineers?|staff|hires?|hiring|background|candidates?|applicants?)\b/i;
const WHICH_ASK =
  /\b(?:which|what|who|whom)\b|\b(?:list|name|cite|use|provide|include|supply|serve)\b|\b(?:clients?|customers?)\b/i;

/**
 * The canonical question, or a model-worded one asking WHICH client
 * references to list ("Which two clients can serve as references?"). A
 * question that merely uses the word in another sense ("Do technicians
 * supply references from past employers?") is not one: the backstop must
 * not swallow it.
 */
export function asksAboutReferences(question: string): boolean {
  if (isReferencesGapQuestion(question)) return true;
  if (!nounHits(question).some((h) => h.plural)) return false;
  return WHICH_ASK.test(question) && !OTHER_PEOPLE.test(question);
}

/** The section's text uses the noun in a client-reference sense at all. */
export function sectionMentionsReferences(paragraphs: string[]): boolean {
  return paragraphs.some((p) => nounHits(p).length > 0);
}

// A sentence that talks ABOUT references without presenting any.
const DEFERRAL =
  /\b(?:up)?on request\b|\bavailable\b|\bwill (?:be )?(?:provide|supply|supplie|furnish|share|follow)|\bcan (?:be )?(?:provide|supply|supplie|furnish|share)|\bto be (?:provided|supplied|furnished|confirmed|named)|\bto follow\b|\b(?:happy|glad|pleased|delighted) to\b/i;
const ETIQUETTE_SHAPE =
  /final step before contract|respect for (?:our )?clients?[’']? time/i;
// The plural noun in a presenting shape: "Our references are Acme Clinic
// and ...", "Client references: Acme Clinic (...)". What follows must be the
// list itself, not where or when it will be ("are included in Appendix B",
// ": to follow").
const PRESENTING =
  /\breferences\b(?:\s+(?:are|include)\b|\s*[:\-–])\s*(?!(?:included|provided|available|attached|listed|shown|given|supplied|enclosed|in|to|on|upon|below|above|as|not|none|tbd|n\/a|called|checked|contacted|always|only|never|required|requested)\b)\S/i;
// An email address or a phone number: a reference's contact line.
const CONTACT =
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+|(?:\(\d{3}\)\s*|\b\d{3}[\s.-])\d{3}[\s.-]\d{4}\b|\b\d{3}-\d{4}\b/;

/**
 * Does the text PRESENT references? POSITIVE evidence only:
 *
 * - the plural noun in a presenting shape ("Our references are ...",
 *   "Client references: ..." followed by the list), or
 * - the noun, outside a deferral or the etiquette sentence, in a paragraph
 *   that (or whose next paragraph) carries a contact token: an email
 *   address or a phone number.
 *
 * Everything else is silence: the verb ("each ticket references the
 * asset"), the idiom ("as a reference", "quick reference card"), another
 * population's references ("we check references for every technician"), a
 * pointer ("please see the references section"), a deferral ("will be
 * supplied at the finalist stage", "to follow") and a refusal ("does not
 * provide client references"). Wrongly reading silence as presenting is
 * what dropped the RFP's ask; wrongly reading a presentation as silence
 * only asks a question a person can dismiss.
 */
export function sectionPresentsReferences(paragraphs: string[]): boolean {
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    let named = false;
    for (const sentence of p.split(/(?<=[.!?])\s+/)) {
      if (DEFERRAL.test(sentence) || ETIQUETTE_SHAPE.test(sentence)) continue;
      const hits = nounHits(sentence);
      if (hits.length === 0) continue;
      if (hits.some((h) => h.plural) && PRESENTING.test(sentence)) return true;
      named = true;
    }
    if (named && (CONTACT.test(p) || CONTACT.test(paragraphs[i + 1] ?? "")))
      return true;
  }
  return false;
}

export type ReferenceCandidate = {
  organization: string;
  segment: string;
  relationshipSince: string | null;
  usableWithoutAsking: boolean;
  hasContact: boolean;
};

const SEGMENT_STOP = new Set(["services", "service", "other", "general"]);

function foldSector(text: string): string {
  return text
    .toLowerCase()
    .replace(/\bnot[\s-]for[\s-]profit\b|\bnon[\s-]profit\b|\bnfp\b/g, "nonprofit")
    .replace(/\bhealth[\s-]care\b/g, "healthcare");
}

/** Candidates whose segment words appear in the RFP first; stable otherwise. */
export function rankReferenceCandidates<C extends ReferenceCandidate>(
  candidates: C[],
  rfpText: string
): C[] {
  const hay = foldSector(rfpText);
  const score = (c: C) => {
    const words = new Set(
      foldSector(c.segment)
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 4 && !SEGMENT_STOP.has(w))
    );
    let n = 0;
    for (const w of words) if (hay.includes(w)) n += 1;
    return n;
  };
  return candidates
    .map((c, i) => ({ c, i, s: score(c) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.c);
}

const WHY_MAX = 900;
const WHY_CANDIDATES = 5;
const WHY_TAIL =
  "Pick the references to list and check each contact; details on file are filled in for you, and new or corrected contacts are kept on file when you say so.";

/**
 * The line under the question: what the RFP asked, and what the knowledge
 * base holds, so the person decides on shown detail instead of a bare ask.
 * The closing line points at the picker (references-block.ts, §5.17.10):
 * contacts on file are prefilled there, and the answer route writes new or
 * corrected ones back only on the person's `keep`.
 *
 * Organization names appear here and ONLY here. `why` is staff-only display
 * text: it is never sent to a model (prompts carry `question` alone) and
 * never exported. `candidates` is null when the knowledge-base read failed;
 * the question still lands, without the shortlist.
 *
 * The parts are joined with "\n": the Questions pane renders them as
 * separate lines (whitespace-pre-line).
 */
export function referencesGapWhy(
  ask: ReferencesAsk,
  candidates: ReferenceCandidate[] | null,
  rfpText: string
): string {
  const quoted = ask.requirement.replace(/\s+/g, " ").trim().slice(0, 200);
  const parts: string[] = [
    ask.fromTitle
      ? `The RFP has a section titled "${quoted}".`
      : `The RFP asks: "${quoted}"`,
  ];
  if (candidates && candidates.length === 0)
    parts.push("The knowledge base holds no client references.");
  if (candidates && candidates.length > 0) {
    const total = candidates.length;
    const withContact = candidates.filter((c) => c.hasContact).length;
    const usable = candidates.filter((c) => c.usableWithoutAsking).length;
    parts.push(
      `The knowledge base holds ${total} client reference${total === 1 ? "" : "s"}, ` +
        `${withContact === 0 ? "none" : withContact} with contact details on file and ` +
        `${usable === 0 ? "none" : usable} cleared to use without asking the client first.`
    );
    const names: string[] = [];
    let spent = parts.join(" ").length + WHY_TAIL.length + 2;
    for (const c of rankReferenceCandidates(candidates, rfpText)) {
      if (names.length >= WHY_CANDIDATES) break;
      const since = c.relationshipSince
        ? `, client since ${c.relationshipSince.slice(0, 40)}`
        : "";
      const entry = `${c.organization.slice(0, 80)} (${c.segment.slice(0, 60)}${since})`;
      if (spent + entry.length + 2 > WHY_MAX) break;
      names.push(entry);
      spent += entry.length + 2;
    }
    if (names.length) parts.push(`Closest by segment: ${names.join("; ")}.`);
  }
  parts.push(WHY_TAIL);
  return parts.join("\n");
}

/**
 * The backstop itself. Returns the gaps to land for one drafted section.
 *
 * When the section's requirements carry a references ask and neither this
 * section nor any other presents references, the canonical question is
 * guaranteed a slot: it is appended AFTER the model's gaps (at most two
 * survive draftSection's cap, so a section lands at most three), and a
 * model-worded gap asking which client references to list is replaced by
 * it, never kept beside it (a gap that merely uses the word in another
 * sense is kept). A references question already open anywhere on the
 * proposal is reused byte for byte, even when it states a different count,
 * so two sections asking for references stay ONE question with one answer.
 *
 * `answeredElsewhere`: another section's record carries
 * `referencesAnswered` (the gap route and the references route stamp it when
 * the question is answered), or this section's own references block is being
 * carried over a redraft. That is the person's answer, whatever the prose
 * looks like, so the question is not raised again, and a model-worded gap
 * asking which client references to list is dropped with it.
 */
export function withReferencesGap(
  gaps: { question: string; why: string }[],
  opts: {
    ask: ReferencesAsk | null;
    paragraphs: string[];
    /** Paragraphs of every OTHER drafted section on the proposal. */
    otherSections: string[][];
    /** collectOpenQuestions() for the target, at landing time. */
    openQuestions: string[];
    why: string;
    answeredElsewhere?: boolean;
  }
): { question: string; why: string }[] {
  if (!opts.ask) return gaps;
  // Answered by a person (on another section, or as the references block a
  // redraft carries): the canonical question is not raised, and a
  // model-worded references question the drafter returned must not reopen
  // it either.
  if (opts.answeredElsewhere) {
    // The SAME array when nothing was dropped: callers compare by identity.
    const kept = gaps.filter((g) => !asksAboutReferences(g.question));
    return kept.length === gaps.length ? gaps : kept;
  }
  if (sectionPresentsReferences(opts.paragraphs)) return gaps;
  if (opts.otherSections.some((p) => sectionPresentsReferences(p))) return gaps;
  const question =
    opts.openQuestions.find(isReferencesGapQuestion) ??
    // A model-worded references question from before the backstop is reused
    // too: two differently worded references questions on one proposal is
    // the duplicate-question bug of §5.17.2 all over again.
    opts.openQuestions.find(asksAboutReferences) ??
    REFERENCES_GAP_QUESTION(opts.ask.count);
  return [
    ...gaps.filter((g) => !asksAboutReferences(g.question)).slice(0, 2),
    { question, why: opts.why },
  ];
}

/**
 * Read-time twin of the backstop, for proposals drafted before it existed:
 * every drafted section whose requirements ask for references while the
 * proposal neither presents them nor has the question open. Nothing calls
 * this on a write path; it exists so a page can flag the miss without a
 * data migration.
 */
export function unansweredReferencesAsks(
  requirements: { structureLabel: string; text: string }[],
  sections: {
    label: string;
    title?: string;
    paragraphs: string[];
    gaps: { question: string }[];
    referencesAnswered?: boolean;
  }[]
): { label: string; count: number | null; requirement: string }[] {
  const drafted = sections.filter((s) => !s.label.startsWith("__"));
  if (
    drafted.some(
      (s) => s.referencesAnswered || sectionPresentsReferences(s.paragraphs)
    )
  )
    return [];
  const out: { label: string; count: number | null; requirement: string }[] =
    [];
  for (const s of drafted) {
    if (s.gaps.some((g) => asksAboutReferences(g.question))) continue;
    const ask = referencesAsk(
      requirements.filter((r) => r.structureLabel === s.label).map((r) => r.text),
      s.title || s.label
    );
    if (ask)
      out.push({ label: s.label, count: ask.count, requirement: ask.requirement });
  }
  return out;
}

/** Rule D3's required statement, verbatim from its `suggestion`
 *  (validators/rules-d.ts). scripts/rfp-references-tests.ts pins the two
 *  against each other. */
export const REFERENCE_ETIQUETTE_SENTENCE =
  "Out of respect for our clients' time, we ask that references be called as a final step before contract rather than earlier in the evaluation.";

/** Mirror of D3's etiquette test over whole-document text. Exported for the
 *  references answer route, which composes the section's intro paragraph
 *  with the etiquette sentence unless the landing text already states it. */
export function statesEtiquette(documentText: string): boolean {
  return (
    /final step before contract/i.test(documentText) ||
    (/respect for (our )?clients?[’']? time/i.test(documentText) &&
      /reference/i.test(documentText))
  );
}

/** Mirror of D3's two tests: no references named, or the etiquette stated. */
function d3Satisfied(documentText: string): boolean {
  if (!/\breferences?\b/i.test(documentText)) return true;
  return statesEtiquette(documentText);
}

/**
 * The answer to the references question declines to give any ("We will not
 * provide references for this proposal", "None").
 */
export function isReferencesRefusal(answer: string): boolean {
  return /\b(?:will\s+not|won[’']t|do\s+not|don[’']t|does\s+not|cannot|can[’']t|declin\w+|not\s+(?:going|able)\s+to)\s+(?:\w+\s+){0,4}references?\b|\bno\s+references\b|^\s*(?:none|n\/a|skip)\b/i.test(
    answer
  );
}

/**
 * After a gap answer is woven: append rule D3's sentence as the section's
 * closing paragraph when the proposal needs it and nowhere states it.
 * Deterministic on purpose: D3 tests for exact wording, and a model asked
 * to reproduce a sentence may paraphrase it.
 *
 * `otherText` is everything ELSE D3 scans at landing time: every other
 * record's label, title and paragraphs (the letter record included), this
 * section's own label and title, and the proposal title. So a question
 * woven into several sections states the etiquette exactly once.
 *
 * `opts.answered` (the canonical references question was just answered):
 * the sentence is appended unless the full text already states the
 * etiquette. It does NOT depend on the woven paragraphs containing the
 * word "reference": an answer woven as a bare list of organizations and
 * contacts is references all the same. With `opts.refusal` the sentence is
 * skipped only when D3 would not block without it (the word appears
 * nowhere); a woven refusal that names references still gets it, because
 * D3 would otherwise BLOCK the proposal.
 *
 * Without `opts.answered` (any other question): appended only when the
 * woven section itself names references and D3 is not satisfied.
 */
export function withReferenceEtiquette(
  paragraphs: string[],
  otherText: string,
  opts?: { answered?: boolean; refusal?: boolean }
): string[] {
  const own = paragraphs.join("\n");
  const all = `${otherText}\n${own}`;
  if (opts?.answered) {
    if (statesEtiquette(all)) return paragraphs;
    if (opts.refusal && d3Satisfied(all)) return paragraphs;
    return [...paragraphs, REFERENCE_ETIQUETTE_SENTENCE];
  }
  if (!/\breferences?\b/i.test(own)) return paragraphs;
  if (d3Satisfied(all)) return paragraphs;
  return [...paragraphs, REFERENCE_ETIQUETTE_SENTENCE];
}

/* ---- the references block's intro paragraph (§5.17.10) ------------------- */

/**
 * The paragraphs a section holds once it carries a references block: the
 * template's intro sentence, with rule D3's etiquette sentence unless the
 * proposal already states the etiquette. THE ONE composer: the references
 * route (first answer and edit) and the generate route's redraft carry both
 * call it, so the two can never disagree about what closes the section.
 *
 * `otherText` is everything ELSE rule D3 scans at landing time, built the way
 * the gap route builds it: the proposal title, every other record's label,
 * title and paragraphs, and this record's own label and title.
 *
 * - The intro is already there (a paragraph that starts with it, or one it
 *   was folded onto): nothing is added, so an edit never lands a second
 *   intro. Only when the etiquette is stated NOWHERE is its sentence appended
 *   to that paragraph.
 * - Otherwise the intro is appended as a new last paragraph, or, when the
 *   section already holds PARAGRAPH_CAP paragraphs, folded onto the end of
 *   the last one: the section route keeps 12 paragraphs, so a 13th would be
 *   cut by the next edit and take the etiquette sentence (and D3) with it.
 */
export function composeReferencesParagraphs(
  paragraphs: string[],
  otherText: string
): string[] {
  const stated = statesEtiquette(`${otherText}\n${paragraphs.join("\n")}`);
  const at = paragraphs.findIndex((p) => p.includes(REFERENCES_INTRO_SENTENCE));
  if (at >= 0) {
    if (stated) return paragraphs;
    return paragraphs.map((p, i) =>
      i === at ? `${p.trimEnd()} ${REFERENCE_ETIQUETTE_SENTENCE}` : p
    );
  }
  const intro =
    REFERENCES_INTRO_SENTENCE + (stated ? "" : ` ${REFERENCE_ETIQUETTE_SENTENCE}`);
  if (paragraphs.length >= PARAGRAPH_CAP && paragraphs.length > 0) {
    const last = paragraphs.length - 1;
    return paragraphs.map((p, i) =>
      i === last ? `${p.trimEnd()} ${intro}` : p
    );
  }
  return [...paragraphs, intro];
}

/**
 * The inverse, for when the references block is removed: a paragraph that is
 * exactly the composed intro (with or without the etiquette sentence) is
 * dropped, and an intro folded onto the end of a paragraph is cut off it,
 * the etiquette sentence directly after it included. A paragraph a person
 * rewrote is theirs and stays; the same array comes back when nothing matched.
 */
export function stripReferencesIntro(paragraphs: string[]): string[] {
  const withEtiquette = `${REFERENCES_INTRO_SENTENCE} ${REFERENCE_ETIQUETTE_SENTENCE}`;
  let changed = false;
  const out: string[] = [];
  for (const p of paragraphs) {
    const t = p.trim();
    if (t === REFERENCES_INTRO_SENTENCE || t === withEtiquette) {
      changed = true;
      continue;
    }
    const tail = [withEtiquette, REFERENCES_INTRO_SENTENCE].find((x) =>
      t.endsWith(` ${x}`)
    );
    if (tail) {
      changed = true;
      out.push(t.slice(0, t.length - tail.length).trimEnd());
      continue;
    }
    out.push(p);
  }
  return changed ? out : paragraphs;
}
