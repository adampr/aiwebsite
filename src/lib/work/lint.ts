// Deterministic publish gate for panel-produced cards (§5.16). Runs in code,
// not in the model: schema shape, string bans, uniqueness, and word bands.
// The model gets ONE regeneration attempt with the violation list; a second
// failure parks the submission as "held" for the owner. Nothing here ever
// rewrites model copy (the em-dash rule exists because of sentence shape,
// not the glyph; a mechanical patch would leave the tell).

import staticTitles from "./static-titles.json";
import {
  BANNED_ADVERBS,
  CATEGORY_BADGES,
  TITLE_KIND_PREFIX_RE,
  WORK_CAPS,
} from "./config";
import { splitMachineEcho } from "./names";

export interface WorkCard {
  title: string;
  categoryBadge: string;
  summary: string;
  body: string[];
  facets: { label: string; text: string }[];
  footerLine: string[];
}

const CARD_KEYS = new Set([
  "title",
  "categoryBadge",
  "summary",
  "body",
  "facets",
  "footerLine",
]);

export function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

/** §5.16 natural-email round (2026-08-03): the description region of every
 * panel prompt. Pure so tests can pin it. Marker runs are neutralized (the
 * title-infer framed() idiom) so pasted text cannot close the data region
 * and address the model as an operator, the text is sliced at the prompt
 * cap with an explicit truncation line (the stored blurb stays verbatim up
 * to the email cap), and an empty blurb renders a sentinel instead of a
 * dangling label. The frame in panel.ts declares this region untrusted
 * alongside the documents. */
export function blurbPromptBlock(blurb: string): string {
  const safe = blurb.replace(/<{3,}|>{3,}/g, "[markers]");
  const sliced = safe.slice(0, WORK_CAPS.blurbPromptMaxChars);
  const body = sliced.trim()
    ? sliced +
      (safe.length > sliced.length
        ? "\n[description truncated for review; the full text stays with the submission]"
        : "")
    : "(none provided; the attached documents are the whole context)";
  return `<<<DESCRIPTION>>>\n${body}\n<<<END DESCRIPTION>>>`;
}

/** Process meta-commentary collocations (2026-07-31 incident: four cards
 * published whose copy was ABOUT the review instead of about the tool,
 * "No supporting source document was submitted for this card"). Every
 * pattern is a multi-word collocation or a word with zero legitimate
 * occurrences across the 24 hand-authored exhibits and the one good
 * community card; bare "document", "documentation", "review", "verified",
 * "draft", "pending" stay legal because real cards use them about the tool
 * ("documented workflow", "searches SweetProcess documentation"). Applied
 * to every visible field EXCEPT the title: titles are submitter-chosen
 * names, and a tool really could be called "Editorial Calendar Builder". */
const META_COMMENTARY_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\bth(?:is|e|at) card\b/i, label: "the card referring to itself" },
  { re: /\bcritic(?:s|'s)?\b/i, label: "review vocabulary (critic)" },
  { re: /\beditorial\b/i, label: "review vocabulary (editorial)" },
  { re: /\bpublication\b/i, label: "review vocabulary (publication)" },
  { re: /\bunverified\b/i, label: "verification-status language" },
  {
    re: /\bnot (?:be )?(?:verified|confirmed|validated|substantiated|established)\b/i,
    label: "verification-status language",
  },
  {
    re: /\bsource (?:document|file|evidence|review|material|artifact|skill)s?\b/i,
    label: "evidence-status language",
  },
  {
    re: /\bsupporting (?:source )?(?:document|artifact|file|material|evidence)s?\b/i,
    label: "evidence-status language",
  },
  {
    re: /\bsubmitted (?:draft|material|evidence|file|document|description)s?\b/i,
    label: "submission-process language",
  },
  {
    re: /\bno\b[^.!?]{0,80}\b(?:was|were) submitted\b/i,
    label: "submission-process language",
  },
  { re: /\bthe submission\b/i, label: "submission-process language" },
  { re: /\bwithheld\b/i, label: "evidence-status language" },
  // Intake-process language (2026-08-29, the cleaning round). A redacted
  // corpus gives the panel a new way to write about OUR pipeline instead of
  // the tool, which is the 2026-07-31 incident's exact shape.
  //
  // "at intake" is ours, never a tool's. The redaction pattern is restricted
  // to PAST and PERFECT passives on purpose: that is the line between
  // reporting what happened to this submission and describing what a tool
  // habitually does. Two published cards say "The proposal is sanitized
  // first" and "The published copy of the skill is sanitized by design" in
  // the present tense, and a credential-scrubbing tool submitted tomorrow
  // would say the same. Widening this to is/are would hold exactly the cards
  // this page exists for.
  { re: /\bat intake\b/i, label: "intake-process language" },
  {
    re: /\b(?:credential|secret|password|api key|token)s?\b[^.!?]{0,30}\b(?:were|was|have been|had been)\s+(?:redacted|removed|stripped|scrubbed|cleaned|sanitized)\b/i,
    label: "intake-process language",
  },
  { re: /\bprovisional(?:ly)?\b/i, label: "evidence-status language" },
  {
    re: /\bevidence (?:was |is |remained )?(?:unavailable|pending|absent|missing|needed)\b/i,
    label: "evidence-status language",
  },
  {
    re: /\bpending (?:source|evidence|review|verification)\b/i,
    label: "evidence-status language",
  },
  {
    re: /\baccompan(?:ied|y|ying) the (?:draft|submission|card)\b/i,
    label: "submission-process language",
  },
];

/** String bans applied to every visible field. Narrow by design (critic
 * ruling): tag-shaped sequences, not bare angle brackets; scheme'd URLs and
 * www., not bare domains; contact shapes (emails, phone numbers) because the
 * panel must never mint a contact path the company does not run. Exported
 * for the ops rerun script, which must run the same bans on an operator
 * title before writing it. */
export function stringViolations(field: string, s: string): string[] {
  const v: string[] = [];
  if (/—|–/.test(s)) v.push(`${field}: contains an em or en dash`);
  if (/<\/?[a-zA-Z]/.test(s) || /&#/.test(s))
    v.push(`${field}: contains markup-shaped text`);
  if (/https?:\/\//i.test(s) || /\bwww\./i.test(s))
    v.push(`${field}: contains a URL (cards carry no links)`);
  if (/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(s))
    v.push(`${field}: contains an email address`);
  if (/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/.test(s))
    v.push(`${field}: contains a phone number`);
  // The intake redaction marker (2026-08-29). The panel reads a cleaned
  // corpus, so a placeholder is sitting right there in the evidence looking
  // like submitter text. Banned in EVERY field including the title, unlike the
  // meta-commentary block: a card is about the tool, never about what was
  // taken out of the package it arrived in, and no tool is named this.
  if (/\[redacted:/i.test(s))
    v.push(`${field}: quotes the intake redaction marker`);
  for (const adverb of BANNED_ADVERBS) {
    if (new RegExp(`\\b${adverb}\\b`, "i").test(s))
      v.push(`${field}: contains the frequency adverb "${adverb}"`);
  }
  if (field === "title") {
    // Machine-name echo backstop (2026-08-04 incident). Title-only: a body
    // paragraph may legitimately write "the export is named X (x-slug)".
    // Because validateWeakTitle runs these bans, this one placement covers
    // the corroborated and inferred rungs, the lintCard publish backstop,
    // and the work:rerun --title operator lever. The message starts with
    // "title" so repairDrift classifies a fire as a title violation, and it
    // prescribes the deterministic fix so the repair model never invents a
    // name.
    const echo = splitMachineEcho(s);
    if (echo)
      v.push(
        `${field}: ends with a parenthetical that repeats the tool's own name; state the name once and drop "(${echo.inner.slice(0, 60)})"`
      );
  }
  if (field !== "title") {
    for (const { re, label } of META_COMMENTARY_PATTERNS) {
      const m = re.exec(s);
      if (m)
        v.push(
          `${field}: ${label} ("${m[0]}"). Cards describe the tool for a reader; they never discuss the review, the submission, or whether evidence exists. If the material cannot support a claim, drop the claim; do not write about the gap.`
        );
    }
  }
  return v;
}

/** Retired-tool opener (2026-08-29 "Ticket Reply Composer" incident). /work
 * shows tools people can still use, so a summary that opens by putting the
 * TOOL in the past tense ("Ticket Reply Composer was a browser-based IT
 * helpdesk app that drafted ...") publishes a live tool as a retirement
 * notice. The panel had been told "past tense for anything that ran" and
 * applied it to the tool itself; the prompt rule is now precise
 * (HOUSE_STYLE_RULES) and this is its deterministic half.
 *
 * NARROW ON PURPOSE. Past tense is legitimate copy nearly everywhere: a
 * one-time event ("The first run processed 40 tickets"), a migration, an
 * incident, a genuinely retired tool described further down the card. Only
 * the summary's OPENING noun phrase is checked, and only the "<name> was"
 * shape (plus "were" behind an article or the title), which is the one that
 * makes a reader think the tool is gone. The article branch is a real noun
 * phrase of at most five words with no clause boundary and no one-time
 * event as a word ("The first run was completed", "The migration was
 * finished" are the past tense the prompt rule permits), so a compliant
 * sentence such as "The tool exports tickets, and the first run was slow"
 * passes; "were" is not accepted after a bare name because "Tickets were
 * routed by hand before this tool shipped" is legitimate before-state copy.
 * A past-tense VERB opener ("Outage Detective monitored ...", "This skill
 * drafted ...") is DELIBERATELY deferred to the panel prompt: it is the same
 * defect class (about 22 more of the 96 published cards on 2026-08-29), it
 * is separable when the subject is the tool, but an "-ed" test needs a
 * stoplist (embed, need, feed, exceed, proceed, succeed) and was not worth a
 * false hold on the first night. Replayed over the 96 published production
 * cards: 27 flagged, every one a tool described as if retired, and no
 * present-tense card flagged. */
const OPENER_NAME = "[A-Z][A-Za-z0-9.'+/-]*(?:\\s+[A-Z][A-Za-z0-9.'+/-]*){0,5}";
const OPENER_MACHINE = "[a-z][A-Za-z0-9.'+/]*[-.][A-Za-z0-9.'+/-]*";
const OPENER_WORD = "[A-Za-z0-9.'+/-]+";
// A clause boundary ends the noun phrase: past this word the sentence is
// talking about something other than its subject.
const OPENER_CLAUSE =
  "(?:and|or|but|that|which|who|whose|when|while|after|before|because|so|if|until|though|where|whether)";
// A one-time EVENT as the head noun is the past tense the prompt rule
// permits ("The first run was completed across 40 tickets", "The migration
// was finished in March"), so the article branch stops at one of these.
const OPENER_EVENT =
  "(?:runs?|migrations?|incidents?|rollouts?|pilots?|outages?|deploys?|deployments?|cutovers?|batch(?:es)?|upgrades?|releases?|rebuilds?|launch(?:es)?|imports?|exports?)";
const OPENER_ARTICLE = `(?:This|The)(?:\\s+(?!(?:${OPENER_CLAUSE}|${OPENER_EVENT})\\b)${OPENER_WORD}){1,5}?`;

export function pastTenseOpener(summary: string, title: string): string | null {
  const escaped = title.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const named = escaped ? `${OPENER_ARTICLE}|${escaped}` : OPENER_ARTICLE;
  const re = new RegExp(
    `^\\s*(?:(?:${named})\\s+(?:was|were)|(?:${OPENER_NAME}|${OPENER_MACHINE})\\s+was)\\b`
  );
  const m = re.exec(summary);
  return m ? m[0].trim() : null;
}

export interface LintContext {
  /** Published community titles/facet labels (lowercased) from the DB. */
  publishedTitles: string[];
  publishedFacetLabels: string[];
}

export interface LintResult {
  ok: boolean;
  violations: string[];
  card?: WorkCard;
}

export function lintCard(raw: unknown, ctx: LintContext): LintResult {
  const violations: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { ok: false, violations: ["card is not an object"] };
  const obj = raw as Record<string, unknown>;
  for (const k of Object.keys(obj))
    if (!CARD_KEYS.has(k)) violations.push(`unknown key "${k}"`);

  const title = typeof obj.title === "string" ? obj.title.trim() : "";
  if (
    title.length < WORK_CAPS.titleMinChars ||
    title.length > WORK_CAPS.titleMaxChars
  )
    violations.push(
      `title must be ${WORK_CAPS.titleMinChars}-${WORK_CAPS.titleMaxChars} characters`
    );
  // Backstop only: both intakes strip or reject category prefixes before a
  // row exists, so a fire here means a new intake path skipped that step.
  if (TITLE_KIND_PREFIX_RE.test(title))
    violations.push(
      `title "${title}" starts with a category prefix that duplicates the badge; the title must be the bare tool name`
    );

  const categoryBadge =
    typeof obj.categoryBadge === "string" ? obj.categoryBadge : "";
  if (!(CATEGORY_BADGES as readonly string[]).includes(categoryBadge))
    violations.push(
      `categoryBadge must be one of: ${CATEGORY_BADGES.join(", ")}`
    );

  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  const sw = wordCount(summary);
  if (sw < WORK_CAPS.summaryMinWords || sw > WORK_CAPS.summaryMaxWords)
    violations.push(
      `summary must be ${WORK_CAPS.summaryMinWords}-${WORK_CAPS.summaryMaxWords} words (got ${sw})`
    );
  // The violation string starts with "summary" so classifyViolations frees
  // exactly that field for the repair stage (repair.ts).
  {
    const opener = pastTenseOpener(summary, title);
    if (opener)
      violations.push(
        `summary describes the tool in the past tense ("${opener.slice(0, 60)}"), which reads as retired; describe what the tool is and does in the present tense, and keep the past tense for a one-time event such as a run or an incident`
      );
  }

  const body = Array.isArray(obj.body)
    ? obj.body.filter((p): p is string => typeof p === "string")
    : [];
  if (
    !Array.isArray(obj.body) ||
    body.length !== (obj.body as unknown[]).length ||
    body.length < WORK_CAPS.bodyParagraphsMin ||
    body.length > WORK_CAPS.bodyParagraphsMax
  )
    violations.push(
      `body must be ${WORK_CAPS.bodyParagraphsMin}-${WORK_CAPS.bodyParagraphsMax} plain-string paragraphs`
    );
  for (const [i, p] of body.entries())
    if (wordCount(p) > WORK_CAPS.paragraphMaxWords)
      violations.push(`body paragraph ${i + 1} exceeds ${WORK_CAPS.paragraphMaxWords} words`);

  const facets = Array.isArray(obj.facets)
    ? (obj.facets as unknown[]).filter(
        (f): f is { label: string; text: string } =>
          typeof f === "object" &&
          f !== null &&
          typeof (f as { label?: unknown }).label === "string" &&
          typeof (f as { text?: unknown }).text === "string"
      )
    : [];
  if (!Array.isArray(obj.facets) || facets.length !== 3 || (obj.facets as unknown[]).length !== 3)
    violations.push("facets must be exactly 3 {label, text} entries");
  for (const [i, f] of facets.entries()) {
    if (f.label.trim().length === 0 || f.label.length > WORK_CAPS.facetLabelMaxChars)
      violations.push(`facet ${i + 1} label must be 1-${WORK_CAPS.facetLabelMaxChars} characters`);
    const fw = wordCount(f.text);
    if (fw < WORK_CAPS.facetTextMinWords || fw > WORK_CAPS.facetTextMaxWords)
      violations.push(
        `facet ${i + 1} text must be ${WORK_CAPS.facetTextMinWords}-${WORK_CAPS.facetTextMaxWords} words (got ${fw})`
      );
  }
  const labelSet = new Set(facets.map((f) => f.label.trim().toLowerCase()));
  if (facets.length === 3 && labelSet.size !== 3)
    violations.push("facet labels must differ from each other");

  const footerLine = Array.isArray(obj.footerLine)
    ? (obj.footerLine as unknown[]).filter(
        (s): s is string => typeof s === "string"
      )
    : [];
  if (
    !Array.isArray(obj.footerLine) ||
    footerLine.length !== (obj.footerLine as unknown[]).length ||
    footerLine.length < WORK_CAPS.footerFragmentsMin ||
    footerLine.length > WORK_CAPS.footerFragmentsMax
  )
    violations.push(
      `footerLine must be ${WORK_CAPS.footerFragmentsMin}-${WORK_CAPS.footerFragmentsMax} plain-string fragments`
    );
  for (const [i, s] of footerLine.entries())
    if (s.trim().length === 0 || s.length > WORK_CAPS.footerFragmentMaxChars)
      violations.push(`footer fragment ${i + 1} must be 1-${WORK_CAPS.footerFragmentMaxChars} characters`);

  // Uniqueness against the hand-authored exhibits (build-checked snapshot)
  // and against already-published community cards (DB).
  const staticTitleSet = new Set(
    staticTitles.titles.map((t: string) => t.toLowerCase())
  );
  const staticFacetSet = new Set(
    staticTitles.facetLabels.map((f: string) => f.toLowerCase())
  );
  if (
    staticTitleSet.has(title.toLowerCase()) ||
    ctx.publishedTitles.includes(title.toLowerCase())
  )
    violations.push(`title "${title}" collides with an existing /work card`);
  for (const f of facets) {
    const l = f.label.trim().toLowerCase();
    if (staticFacetSet.has(l) || ctx.publishedFacetLabels.includes(l))
      violations.push(`facet label "${f.label}" collides with an existing /work facet title`);
  }

  // Per-field string bans.
  const fields: [string, string][] = [
    ["title", title],
    ["summary", summary],
    ...body.map((p, i): [string, string] => [`body ${i + 1}`, p]),
    ...facets.flatMap((f, i): [string, string][] => [
      [`facet ${i + 1} label`, f.label],
      [`facet ${i + 1} text`, f.text],
    ]),
    ...footerLine.map((s, i): [string, string] => [`footer ${i + 1}`, s]),
  ];
  for (const [name, value] of fields)
    violations.push(...stringViolations(name, value));

  // Whole-card visible word band (measured against the real exhibits; see
  // WORK_CAPS comment).
  const total =
    wordCount(summary) +
    body.reduce((n, p) => n + wordCount(p), 0) +
    facets.reduce((n, f) => n + wordCount(f.text), 0);
  if (total < WORK_CAPS.cardMinWords || total > WORK_CAPS.cardMaxWords)
    violations.push(
      `card visible copy must total ${WORK_CAPS.cardMinWords}-${WORK_CAPS.cardMaxWords} words (got ${total})`
    );

  if (violations.length > 0) return { ok: false, violations };
  return {
    ok: true,
    violations: [],
    card: { title, categoryBadge, summary, body, facets, footerLine },
  };
}

/** True when a disclosure checklist answer means "nothing found". Models
 * drift on the exact phrase (quotes, trailing period, "None."), and a
 * drifted no-finding must not become a false hold. */
export function isNoneFound(answer: string): boolean {
  const norm = answer
    .trim()
    .replace(/^["'`]+|["'`.]+$/g, "")
    .trim()
    .toLowerCase();
  return norm === "" || norm === "none found" || norm === "none";
}

/** Deterministic check that an adjudication quote actually appears in the
 * submitted documents (whitespace-normalized, case-insensitive). The model
 * proposes the clearing evidence; CODE verifies it, so the gate cannot be
 * talked open by an invented quote. */
export function quoteInCorpus(quote: string, corpusText: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const q = norm(quote);
  if (q.length < 15) return false; // too short to be real evidence
  return norm(corpusText).includes(q);
}

/** team-<slug> namespace guarantees disjointness from hand-authored ids. */
export function slugForTitle(title: string): string {
  return (
    "team-" +
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
  );
}
