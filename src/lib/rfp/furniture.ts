// Cover, letterhead, closing and part furniture: ONE author for the
// workspace sheets, resolve-draft (and so the gate) and both emitters
// (§5.17.5, §5.17.20, §5.17.21, §5.17.22). Pure and client-safe: no node:fs,
// no lookbehind, and the only runtime import is outline.ts (itself
// import-free, and the home of the questionnaire predicate every surface
// reads), so workspace.tsx renders exactly the strings the files print.

import {
  isAnswerVerdict,
  isQuestionnaireSection,
  partCorpusOf,
  partDigitsStated,
  questionnaireRefs,
  resolveParts,
  type PartGroundSection,
  type RefRequirementLike,
} from "./outline";
import type { ResponseMatrixRow, StatTile } from "./content-model/blocks";
//
// Every input is a STORED field (rfp_documents.contact_name / contact_title /
// client_address / proposal_headline, the letter record's `thesis`), already
// grounded and sanitized where it landed (brief.ts groundContact, brain.ts
// for the round-32 fields). Nothing here reads raw intake text or model
// output; the guards below only DROP a value that is not furniture-shaped,
// they never rewrite one into something new.

/** The navy closing sheet's fallback big line (§5.17.5). The letter's
 *  thesis replaces it when the letter turn returned one (§5.17.20). */
export const CLOSING_HEADLINE =
  "Because our fee is flat, our incentive is to prevent issues, not to bill for them.";

/** A real RFP's cover title (resolve-draft cover.title). */
export const RFP_COVER_TITLE = "Response to Request for Proposal";

const clean = (s: string | null | undefined): string =>
  (s ?? "").replace(/\s+/g, " ").trim();

/**
 * The cover's big title. A real RFP keeps "Response to Request for
 * Proposal" (rule C4 territory: its structure and furniture are the
 * client's). A brief prints its stored narrative headline when the read
 * produced one, else today's "Proposal for <who>".
 */
export function coverTitle(o: {
  intakeForm: string;
  /** The client, else the proposal title (resolve-draft cover.clientName). */
  who: string | null;
  proposalHeadline: string | null | undefined;
}): string {
  if (o.intakeForm !== "brief") return RFP_COVER_TITLE;
  const headline = clean(o.proposalHeadline);
  if (headline) return headline;
  const who = clean(o.who);
  return who ? `Proposal for ${who}` : "Proposal";
}

/** "Name, Title" (or the name alone) for the cover's Attention clause. */
function attention(contactName: string | null | undefined, contactTitle: string | null | undefined): string | null {
  const name = clean(contactName);
  if (!name) return null;
  const title = clean(contactTitle);
  return title ? `${name}, ${title}` : name;
}

/** Ends a sentence without doubling a period the title already carries ("Inc."). */
const sentence = (s: string): string => (s.endsWith(".") ? s : `${s}.`);

/** doc-title.ts's case- and punctuation-insensitive fold, for the generic-subject screen. */
const foldTitle = (s: string): string =>
  s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** doc-title.ts GENERIC_SUBJECT, the same pattern: a line that only says what KIND of document
 *  this is ("REQUEST FOR PROPOSALS"), or a contract/date line, titles nothing. Copied, not
 *  imported, because doc-title.ts carries a lookbehind and this module ships to the browser;
 *  test:rfpcoverletter pins the two screens equal. */
const GENERIC_RFP_SUBJECT =
  /^(?:(?:request|requests) for (?:proposals?|quotes?|quotations?|qualifications?|information|bids?)|rf[pqi]|invitation to bid|solicitation|(?:contract|due|date|deadline)\b.*)$/;

/**
 * The stored rfpTitle as the real-RFP cover lede prints it (§5.17.22), or null for today's lede.
 * Tidied the way doc-title.ts composeDocTitle tidies the subject it puts in the stored title: an
 * em dash (or a lookalike: U+2015, U+2E3A, U+2E3B, U+FE58, U+FE31, U+FE32) and a spaced en dash
 * become " · ", whitespace collapses, a heading marker and trailing separators go. A title the
 * generic-subject screen refuses (it names only the kind of document) keeps today's lede, so the
 * lede never reads "in response to your REQUEST FOR PROPOSALS."
 */
export function ledeRfpTitle(raw: string | null | undefined): string | null {
  const t = clean(raw)
    .replace(/\s*[\u2014\u2015\u2E3A\u2E3B\uFE58\uFE31\uFE32]\s*/g, " · ")
    .replace(/\s+\u2013\s+/g, " · ")
    .replace(/^#+\s*/, "")
    .replace(/^[\s:;,·-]+|[\s:;,·-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t || !/\p{L}/u.test(t) || GENERIC_RFP_SUBJECT.test(foldTitle(t))) return null;
  return t;
}

/**
 * The whole cover lede, or undefined when the emitters compose today's RFP
 * form themselves (coverLedeParts). Byte-identical to the pre-round-32 lede
 * whenever no contact (and, round 34, no rfpTitle) is stored:
 *   - rfp, no contact: undefined ("Prepared for <who> in response to ...")
 *   - rfp, contact:    "Prepared for <who>, Attention: <name>, <title>, in
 *                       response to the Request for Proposal."
 *   - rfp, stored rfpTitle (§5.17.22): "Prepared for <who> in response to
 *                       your <rfpTitle>." (with the Attention clause when a
 *                       contact is stored)
 *   - brief, no contact or no who: "Prepared by XL.net for your review."
 *   - brief, contact:  "Prepared for <who>, Attention: <name>, <title>."
 * `rfpTitle` is the read's grounded-verbatim subject line (doc-title.ts
 * groundRfpTitle); a brief never prints it.
 */
export function coverLede(o: {
  intakeForm: string;
  who: string | null;
  contactName: string | null | undefined;
  contactTitle: string | null | undefined;
  rfpTitle?: string | null;
}): string | undefined {
  const attn = attention(o.contactName, o.contactTitle);
  const who = clean(o.who);
  if (o.intakeForm === "brief") {
    return attn && who
      ? sentence(`Prepared for ${who}, Attention: ${attn}`)
      : "Prepared by XL.net for your review.";
  }
  const rfpTitle = ledeRfpTitle(o.rfpTitle);
  if (rfpTitle) {
    const yours = `in response to your ${rfpTitle}`;
    if (!who) return sentence(attn ? `Prepared ${yours}, Attention: ${attn}` : `Prepared ${yours}`);
    return sentence(attn ? `Prepared for ${who}, Attention: ${attn}, ${yours}` : `Prepared for ${who} ${yours}`);
  }
  if (!attn) return undefined;
  return who
    ? `Prepared for ${who}, Attention: ${attn}, in response to the Request for Proposal.`
    : sentence(`Prepared in response to the Request for Proposal, Attention: ${attn}`);
}

/**
 * The cover lede split so every surface sets the client semibold. With no
 * resolved lede it is today's RFP form; a resolved lede that opens
 * "Prepared for <client>" is split on the client; any other lede (a brief's
 * "Prepared by XL.net for your review.") prints whole.
 */
export function coverLedeParts(
  clientName: string,
  lede?: string
): { before: string; strong: string; after: string } {
  if (lede) {
    // coverLede cleaned the name it wrote; match on the same form.
    const name = clean(clientName);
    const head = `Prepared for ${name}`;
    if (name && lede.startsWith(head))
      return { before: "Prepared for ", strong: name, after: lede.slice(head.length) };
    return { before: lede, strong: "", after: "" };
  }
  return clientName
    ? {
        before: "Prepared for ",
        strong: clientName,
        after: " in response to the Request for Proposal.",
      }
    : {
        before: "Prepared in response to the Request for Proposal.",
        strong: "",
        after: "",
      };
}

/**
 * The letterhead's recipient lines above the postal block, as the reference
 * letter sets them: ONLY the first line is set bold (every surface sets
 * line 0 in the semibold face, the rest regular).
 *   - a contact: the name, then the title beneath it, then the client
 *   - no contact: the client alone, else "the client" (byte-identical to
 *     the pre-round-32 block)
 * A contact with no client name stands alone with its title.
 */
export function letterAddresseeLines(o: {
  contactName: string | null | undefined;
  contactTitle: string | null | undefined;
  clientName: string | null | undefined;
}): string[] {
  const name = clean(o.contactName);
  const client = (o.clientName ?? "").trim();
  if (!name) return [client || "the client"];
  const title = clean(o.contactTitle);
  return [name, ...(title ? [title] : []), ...(client ? [client] : [])];
}

/**
 * The cover's SUBMITTED BY person line: the signer's name with the role the
 * letter's signature prints ("Adam Radulovic, CEO"), or the name alone when
 * the signer has no directory title.
 */
export function submittedByLine(name: string, title: string | null | undefined): string {
  const t = clean(title);
  return t ? `${name}, ${t}` : name;
}

/** Running footer, left slot, before the client (§5.17.20). */
export const FOOT_LEFT_BASE = "XL.net · Managed IT Services Proposal";

/** The longest left footer slot that still sets on one line beside
 *  "Confidential" in the PDF's letterspaced 9px caps (about 86 characters
 *  fit; the screen and Word have at least that room). */
export const FOOT_LEFT_MAX = 80;

/**
 * The running footer's left slot on every sheet of all three surfaces:
 * "XL.net · Managed IT Services Proposal for <who>", the base alone when no
 * one is named or when the whole would pass FOOT_LEFT_MAX (a long client
 * name never collides with "Confidential" and is never cut; the divider
 * sheets still name the client). `who` is the cover's name (the client,
 * else the proposal title), the same one the section dividers print.
 */
export function pageFootLeft(who: string | null | undefined): string {
  const w = clean(who);
  const full = `${FOOT_LEFT_BASE} for ${w}`;
  return w && full.length <= FOOT_LEFT_MAX ? full : FOOT_LEFT_BASE;
}

/** The most address lines the letterhead prints (the reader stores at most 5). */
export const ADDRESS_LINES_MAX = 5;

/**
 * The letterhead's postal lines from the stored client_address ("\n"
 * joined). Whitespace collapsed, empties dropped, capped, and a line that
 * merely repeats a name the block already prints (the contact, the title,
 * the client) dropped so the block never says it twice.
 */
export function recipientAddressLines(
  raw: string | null | undefined,
  alreadyPrinted: (string | null | undefined)[]
): string[] {
  if (!raw) return [];
  const seen = new Set(alreadyPrinted.map((s) => clean(s).toLowerCase()).filter(Boolean));
  const out: string[] = [];
  for (const part of raw.split("\n")) {
    const line = clean(part);
    if (!line || seen.has(line.toLowerCase())) continue;
    seen.add(line.toLowerCase());
    out.push(line);
    if (out.length >= ADDRESS_LINES_MAX) break;
  }
  return out;
}

/**
 * Where the system pricing paragraph sits among the letter's body
 * paragraphs (the index it is inserted AT): before the LAST drafted
 * paragraph when there are two or more (the reference letter runs context,
 * why-us, pricing, then timing and the close), else after the body. One rule
 * for the screen sheet, Word and the PDF.
 */
export function pricingParagraphIndex(bodyLength: number): number {
  return bodyLength >= 2 ? bodyLength - 1 : Math.max(0, bodyLength);
}

/** The letter's paragraphs in reading order, the pricing paragraph placed
 *  by pricingParagraphIndex; the body alone when there is none. The round-34
 *  roadmap sentence (letterRoadmapSentence), when present, sits at the same
 *  place directly BEFORE the pricing paragraph: after the drafted body's
 *  substance, before the price and the close. Absent, the result is exactly
 *  what it was before round 34. */
export function letterParagraphsWithPricing(
  body: string[],
  pricing: string | null,
  roadmap: string | null = null
): string[] {
  const furniture = [...(roadmap ? [roadmap] : []), ...(pricing ? [pricing] : [])];
  if (!furniture.length) return body;
  const at = pricingParagraphIndex(body.length);
  return [...body.slice(0, at), ...furniture, ...body.slice(at)];
}

/** The longest thesis the closing sheet prints (the letter turn caps it at 90). */
const THESIS_MAX = 120;

/**
 * Two or more combining marks stacked on one character after NFC ("zalgo"
 * text): never furniture. NFC first, so a decomposed but ordinary letter
 * (Vietnamese "\u1ec7" typed as e + two marks) composes and passes. Shared by the
 * store-side screens in brain.ts (address, headline, title, thesis).
 */
export function hasStackedMarks(s: string): boolean {
  return /\p{Mn}{2,}/u.test(String(s ?? "").normalize("NFC"));
}

/**
 * What the closing sheet refuses to print as a thesis: a digit, a "$", an
 * en or em dash, an angle bracket, or stacked combining marks. ONE predicate
 * for both sides: brain.ts screenLetterThesis refuses the same at store, so a
 * thesis that stores always renders.
 */
export function thesisRefused(t: string): boolean {
  return /[0-9$\u2013\u2014<>]/.test(t) || hasStackedMarks(t);
}

/**
 * The letter record's stored `thesis`, when it is still closing-sheet
 * furniture: a non-empty string, short, and nothing thesisRefused names.
 * Anything else is ignored (the closing falls back to CLOSING_HEADLINE); it
 * is never repaired.
 */
export function letterThesis(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = clean(raw);
  if (!t || t.length > THESIS_MAX) return null;
  if (thesisRefused(t)) return null;
  return t;
}

/** The navy closing sheet's big line: the thesis, else the flat-fee line. */
export function closingHeadline(thesis: string | null | undefined): string {
  return letterThesis(thesis) ?? CLOSING_HEADLINE;
}

/* ---- Section kickers and thematic parts (§5.17.21) ---------------------- */

/**
 * THE section-kicker rule on every sheet of a document without parts (a real
 * RFP): bare labels get a "Section " prefix, roman numerals are tested as
 * numerals first ("III" and "VII" contain 3+ letters and would otherwise
 * render bare beside "Section II"), already-worded labels pass through.
 * The workspace's secKicker and export-assets' sectionKicker are both THIS
 * function now (they were a pinned replica pair before round 33).
 */
export function sectionKicker(label: string): string {
  const t = label.trim();
  if (!t) return "Section";
  if (/^M{0,4}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/i.test(t))
    return `Section ${t}`;
  return /[a-z]{3,}/i.test(t) ? t : `Section ${t}`;
}

/** One resolved thematic part: the divider's copy and its member labels in
 *  sheet order (outline.ts resolveParts, drafted sections only). `n` is the
 *  canonical part, `position` the number it prints (§5.17.21). */
export type DocPart = {
  n: 1 | 2 | 3 | 4;
  title: string;
  dek: string | null;
  labels: string[];
  holdsPricing: boolean;
  position: number;
  pricingKicker: string | null;
};

/** A brief document's parts plus the part-relative kicker ("Section 1.4"). */
export type DocParts = { parts: DocPart[]; kicker: (label: string) => string };

/**
 * The drafted sections in the order every surface prints them: the
 * structure's order (rule C4), then any drafted section whose label the
 * structure no longer names, in stored order. resolve-draft orders its
 * sections with this, and the part resolution below takes the same list, so
 * the screen, the gate and both files agree on what part 1's fourth sheet is.
 */
export function orderDrafted<T extends { label: string }>(
  structure: readonly { label: string }[],
  drafted: readonly T[]
): T[] {
  const ordered: T[] = [];
  for (const node of structure) {
    const sec = drafted.find((s) => s.label === node.label);
    if (sec) ordered.push(sec);
  }
  for (const sec of drafted) if (!ordered.includes(sec)) ordered.push(sec);
  return ordered;
}

/**
 * THE part resolution all four surfaces consume (resolve-draft, so the
 * gate and both emitters through the resolved view, and the workspace doc
 * pane): outline.ts resolveParts over the drafted sections in print order,
 * the stored parts_json overrides, and whether a quote exists. Null = the
 * legacy layout (a real RFP: two dividers, label kickers, byte-identical).
 * `drafted` must already exclude the letter record.
 *
 * Two dek rules apply here, at render, where the drafted text is at hand:
 * - a STORED dek whose digit runs are not all stated whole in its part's
 *   CURRENT drafted text (outline.ts partCorpusOf, the corpus the write
 *   screens grounded it on) reads null: a redraft that dropped the date it
 *   named must not leave the date on the divider;
 * - the part that holds pricing prints `pricingDek` (quote.ts
 *   partPricingDek, composed by the system from the stored quote) IN PLACE
 *   of any stored dek; the stored dek is the fallback only when that is
 *   null (no quote).
 */
export function documentParts(o: {
  intakeForm: string;
  structure: readonly { label: string; title: string }[];
  drafted: readonly PartGroundSection[];
  partsJson: string | null | undefined;
  pricingPresent: boolean;
  pricingDek?: string | null;
}): DocParts | null {
  const ordered = orderDrafted(o.structure, o.drafted);
  const resolved = resolveParts({
    briefMode: o.intakeForm === "brief",
    structure: ordered.map((s) => ({ label: s.label, title: s.title })),
    partsJson: o.partsJson ?? null,
    pricingPresent: o.pricingPresent,
  });
  if (!resolved) return null;
  const pricingDek = typeof o.pricingDek === "string" && o.pricingDek !== "" ? o.pricingDek : null;
  return {
    kicker: resolved.kicker,
    parts: resolved.parts.map((p) => {
      let dek = p.dek;
      if (dek !== null && !partDigitsStated(dek, partCorpusOf(ordered, p.n))) dek = null;
      if (p.holdsPricing && pricingDek !== null) dek = pricingDek;
      return { ...p, dek };
    }),
  };
}

/** A section sheet's kicker: the part-relative one when the document has
 *  parts ("Section 1.4"), else sectionKicker (a real RFP, unchanged). The
 *  label itself never changes; only the displayed kicker does. */
export function sheetKicker(label: string, parts: Pick<DocParts, "kicker"> | null): string {
  return parts ? parts.kicker(label) : sectionKicker(label);
}

/** A part divider's ghost numeral: "01".."04". */
export function partNumeral(n: number): string {
  return String(n).padStart(2, "0");
}

/* ---- The questionnaire matrix and client echo (§5.17.22) ---------------- */

/** The matrix table's column heads, in every surface's order. */
export const MATRIX_HEAD = ["ID", "Response", "Explanation"] as const;
/** The caps label before a row's system rate note. */
export const MATRIX_RATE_LABEL = "Added cost";
/** The summary furniture's two captions (the reference's own wording). */
export const MATRIX_SUMMARY_CAPTION = "Response summary";
export const MATRIX_COST_CAPTION = "Items that involve added cost or a third party";
export const MATRIX_COST_HEAD = ["Item", "What it involves"] as const;
/** A pdf sheet a matrix carries onto: its title plus this. */
export const MATRIX_CONTINUED = "(continued)";
/** The client-echo chrome. */
export const ECHO_TOLD_LABEL = "What you told us";
export const ECHO_SEE_TITLE = "What you will see";

/** The matrix column widths, as fractions of the sheet (ID, pill, explanation). */
export const MATRIX_COLUMN_FRACTIONS = [0.12, 0.17, 0.71] as const;

/** One stored answer as the drafter's landing writes it (the section
 *  record's `answers`, contract Q1b). Read loosely: stored JSON is never
 *  trusted as typed. */
type StoredAnswer = {
  ref?: unknown;
  verdict?: unknown;
  subject?: unknown;
  explanation?: unknown;
  cites?: unknown;
  rateCodes?: unknown;
};

/**
 * A section's stored `answers` lifted into the response-matrix body, in the
 * CLIENT's order (requirement ordinal, outline.ts questionnaireRefs), one
 * row per ref (the first stored answer for a ref wins). Only a section that
 * IS a questionnaire section now (outline.ts isQuestionnaireSection, derived
 * from the requirements on every read) lifts at all, so answers left on a
 * record by an earlier read print nothing. Defensive, never repairing: an answer whose
 * ref is not a clientRef of THIS section's requirements, whose verdict is
 * outside the enum, or whose subject or explanation is not a string is
 * skipped (the ref then reads as missing, rule D7's redraft case), and a ref
 * nobody answered gets no row. `rateNote` is composed by the SYSTEM from the
 * answer's rate-card codes through `rateNote` (quote.ts rateNoteFor, passed
 * in so this module stays import-light); the model's text never reaches it.
 * `cites` is the union of the kept answers' cites. Null when no row survives.
 * resolve-draft (so the gate and both files) and the workspace both call it.
 */
export function matrixFromAnswers(o: {
  answers: unknown;
  label: string;
  requirements: readonly RefRequirementLike[];
  rateNote: (codes: string[]) => string | null;
}): { rows: ResponseMatrixRow[]; cites: string[] } | null {
  if (!Array.isArray(o.answers) || o.answers.length === 0) return null;
  if (!isQuestionnaireSection(o.requirements, o.label)) return null;
  const byRef = new Map<string, StoredAnswer>();
  for (const a of o.answers as unknown[]) {
    if (!a || typeof a !== "object" || Array.isArray(a)) continue;
    const ans = a as StoredAnswer;
    if (typeof ans.ref !== "string" || byRef.has(ans.ref)) continue;
    byRef.set(ans.ref, ans);
  }
  const rows: ResponseMatrixRow[] = [];
  const cites: string[] = [];
  for (const ref of questionnaireRefs(o.requirements, o.label)) {
    const ans = byRef.get(ref);
    if (!ans) continue;
    if (!isAnswerVerdict(ans.verdict)) continue;
    if (typeof ans.subject !== "string" || typeof ans.explanation !== "string") continue;
    const codes = Array.isArray(ans.rateCodes)
      ? ans.rateCodes.filter((c): c is string => typeof c === "string" && c !== "")
      : [];
    const note = codes.length ? o.rateNote(codes) : null;
    rows.push({
      ref,
      verdict: ans.verdict,
      subject: ans.subject,
      explanation: ans.explanation,
      ...(note ? { rateNote: note } : {}),
    });
    if (Array.isArray(ans.cites))
      for (const c of ans.cites) if (typeof c === "string" && !cites.includes(c)) cites.push(c);
  }
  return rows.length ? { rows, cites } : null;
}

/**
 * quote.ts rateNoteFor, for a surface that holds each nameable code's own
 * note rather than the rate card (the workspace; page.tsx composes the table
 * with rateNoteFor per code): every code once, in the order given, unknown
 * codes skipped, joined with "; ", which is rateNoteFor's own composition
 * (test:rfpcoverletter pins the two equal over the seed card).
 */
export function rateNoteFromTable(codes: readonly string[], notes: Readonly<Record<string, string>>): string | null {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const code of codes) {
    if (typeof code !== "string" || seen.has(code)) continue;
    seen.add(code);
    const note = Object.prototype.hasOwnProperty.call(notes, code) ? notes[code] : undefined;
    if (typeof note === "string" && note) parts.push(note);
  }
  return parts.length ? parts.join("; ") : null;
}

/**
 * A questionnaire section's kicker: the sheet's own kicker (sectionKicker on
 * a real RFP, the part-relative one on a brief) plus its range of client IDs,
 * "Section 1 · OC-01 to OC-04" (every surface sets kickers in caps). A
 * section without matrix rows keeps its kicker exactly.
 */
export function matrixKicker(kicker: string, rows: readonly { ref: string }[]): string {
  if (!rows.length) return kicker;
  const first = rows[0]!.ref;
  const last = rows[rows.length - 1]!.ref;
  return first === last ? `${kicker} · ${first}` : `${kicker} · ${first} to ${last}`;
}

/**
 * Every client ref the document's questionnaire sections carry, in section
 * order (first appearance of each structure label among the requirements)
 * and the client's order within each (outline.ts questionnaireRefs). The
 * base the summary's total and the roadmap's "every" are honest against:
 * an item nobody answered is still one of the client's items.
 */
export function allQuestionnaireRefs(
  requirements: readonly RefRequirementLike[]
): { label: string; ref: string }[] {
  const reqs = Array.isArray(requirements) ? requirements : [];
  const labels: string[] = [];
  for (const r of reqs)
    if (r && typeof r.structureLabel === "string" && !labels.includes(r.structureLabel)) labels.push(r.structureLabel);
  // Scoped per SECTION, never deduped across sections: questionnaires often
  // number per section ("1".."6" in each), and a cross-section dedupe made
  // the summary count section B's items as already answered by section A's
  // rows, so "every item" could print beside a missing row.
  const out: { label: string; ref: string }[] = [];
  for (const label of labels)
    if (isQuestionnaireSection(reqs, label))
      for (const ref of questionnaireRefs(reqs, label)) out.push({ label, ref });
  return out;
}

/** The one answered-set key: a row answers a ref IN ITS OWN SECTION only. */
const scopedRef = (label: string, ref: string) => `${label}\u0000${ref}`;

/** The system summary on its own sheet before the FIRST matrix section's:
 *  counts across every matrix section, the items answered no, and the
 *  added-cost index. Computed from the stored rows and the client's refs
 *  only; no model text. */
export type MatrixSummary = {
  /** The structure label of the first matrix section, whose sheet it precedes. */
  label: string;
  /** The client's items: every questionnaire ref, answered or not. */
  total: number;
  yes: number;
  partial: number;
  no: number;
  na: number;
  /** Client refs with no row (total minus the rows). */
  missing: number;
  noRefs: string[];
  /** The items answered no, each with its row's subject ("" when none). */
  noItems: { ref: string; subject: string }[];
  costIndex: { ref: string; rateNote: string }[];
};

/** Null when no section carries a matrix row. `sections` in print order;
 *  `clientRefs` every ref of the client's questionnaire
 *  (allQuestionnaireRefs), so the total counts the items nobody answered
 *  too. Without it the total is the rows alone. */
export function matrixSummaryOf(
  sections: readonly { label: string; rows: readonly ResponseMatrixRow[] }[],
  clientRefs: readonly { label: string; ref: string }[] = []
): MatrixSummary | null {
  const withRows = sections.filter((s) => s.rows.length > 0);
  if (!withRows.length) return null;
  const all = withRows.flatMap((s) => s.rows);
  const answered = new Set(withRows.flatMap((s) => s.rows.map((r) => scopedRef(s.label, r.ref))));
  const unanswered = clientRefs.filter((c) => !answered.has(scopedRef(c.label, c.ref))).length;
  const noRows = all.filter((r) => r.verdict === "no");
  return {
    label: withRows[0]!.label,
    total: all.length + unanswered,
    yes: all.filter((r) => r.verdict === "yes").length,
    partial: all.filter((r) => r.verdict === "partial").length,
    no: noRows.length,
    na: all.filter((r) => r.verdict === "na").length,
    missing: unanswered,
    noRefs: noRows.map((r) => r.ref),
    noItems: noRows.map((r) => ({ ref: r.ref, subject: typeof r.subject === "string" ? clean(r.subject) : "" })),
    costIndex: all.flatMap((r) => (r.rateNote ? [{ ref: r.ref, rateNote: r.rateNote }] : [])),
  };
}

/** The summary's tiles, in the reference's order and wording, plus an N/A
 *  tile when any row is n/a. The first tile's total is the client's items,
 *  answered or not. */
export function matrixSummaryTiles(s: MatrixSummary): StatTile[] {
  return [
    { value: String(s.yes), label: `of ${s.total} ${s.total === 1 ? "item" : "items"} answered yes` },
    { value: String(s.partial), label: "answered partial, with the reason given" },
    { value: String(s.no), label: "answered no" },
    ...(s.na > 0 ? [{ value: String(s.na), label: "answered N/A, not applicable" }] : []),
  ];
}

/** "A and B" / "A, B and C". */
function andList(xs: readonly string[]): string {
  if (xs.length <= 1) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/** The line under the tiles naming every item answered no, each by its
 *  subject with the ref after it ("No exit dependency (OC-08)"), the ref
 *  alone when the row has no subject; null when none. */
export function matrixNoLine(s: MatrixSummary): string | null {
  const items = s.noItems?.length ? s.noItems : s.noRefs.map((ref) => ({ ref, subject: "" }));
  if (!items.length) return null;
  const named = items.map((i) => (i.subject ? `${i.subject.replace(/[.\s]+$/, "")} (${i.ref})` : i.ref));
  return `Answered no: ${andList(named)}.`;
}

/** True when every one of the client's refs has a matrix row: only then may
 *  system copy say "every item". */
export function matrixComplete(
  sections: readonly { label: string; rows: readonly { ref: string }[] }[],
  clientRefs: readonly { label: string; ref: string }[]
): boolean {
  const answered = new Set(sections.flatMap((s) => s.rows.map((r) => scopedRef(s.label, r.ref))));
  return clientRefs.length > 0 && clientRefs.every((c) => answered.has(scopedRef(c.label, c.ref)));
}

/** The honesty line under the tiles when rows are missing, so the tile
 *  counts visibly do not have to sum to the total: null when none. */
export function matrixMissingLine(s: MatrixSummary): string | null {
  if (!s.missing) return null;
  return `${s.missing} ${s.missing === 1 ? "item has" : "items have"} no response yet; the checks name ${s.missing === 1 ? "it" : "them"}.`;
}

/** The summary sheet's furniture (§5.17.22, F6): its own system sheet in the
 *  reference's "How to Read This Response" register, before the first
 *  matrix section's sheet. The kicker and the opening paragraph are fixed
 *  system copy; every number on the sheet comes from the stored rows. */
export const MATRIX_SUMMARY_KICKER = "Questionnaire · Overview";
export const MATRIX_SUMMARY_TITLE = "How to Read This Response";
export const MATRIX_SUMMARY_INTRO =
  "Each item in the pages that follow carries its ID from your questionnaire, a one-word response (Yes, Partial, No or N/A) and a short explanation.";
/** The intro's second sentence, only when the cost index prints. */
export const MATRIX_SUMMARY_COST_LINE =
  "Items whose answer involves an added cost or a third party are listed below with the rate that applies.";

/** The intro paragraph as every surface prints it. */
export function matrixSummaryIntro(costIndexLength: number): string {
  return costIndexLength > 0 ? `${MATRIX_SUMMARY_INTRO} ${MATRIX_SUMMARY_COST_LINE}` : MATRIX_SUMMARY_INTRO;
}

/** The echo's quote as every surface prints it: the client's words inside
 *  typographic quotes, nothing else changed. */
export const echoQuote = (said: string): string => `\u201c${said}\u201d`;

/** An echo answer's paragraphs (stored with newlines between them). */
export function echoParagraphs(answer: string): string[] {
  return answer
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

const PART_WORDS = ["", "one", "two", "three", "four"];

/**
 * The cover letter's one SYSTEM roadmap sentence (§5.17.22), composed from
 * what the document actually holds, never by the model (the §5.17.20 prompt
 * ban on describing the layout stays): the questionnaire sections that answer
 * by ID, a brief's parts, the Investment page. Null unless at least one
 * section carries a response matrix, so a document without one (a real RFP or
 * a brief from before round 34) prints its letter exactly as before.
 * `matrixKickers` are those sections' sheet kickers (sectionKicker, or the
 * part-relative one), in print order.
 */
export function letterRoadmapSentence(o: {
  matrixKickers: readonly string[];
  partsCount: number;
  pricing: boolean;
  /** Every client ref has a row (matrixComplete). Only then "every item";
   *  absent or false, "your questionnaire item by item". */
  complete?: boolean;
}): string | null {
  if (!o.matrixKickers.length) return null;
  const clauses: string[] = [];
  if (o.partsCount >= 2 && o.partsCount <= 4)
    clauses.push(`the response runs in ${PART_WORDS[o.partsCount]} parts`);
  const many = o.matrixKickers.length > 1;
  const verb = many ? "answer" : "answers";
  clauses.push(
    o.complete === true
      ? `${andList(o.matrixKickers)} ${verb} every item of your questionnaire by its own ID, with a summary of the answers first`
      : `${andList(o.matrixKickers)} ${verb} your questionnaire item by item, with a summary of the answers first`
  );
  if (o.pricing) clauses.push("the Investment page sets out the pricing");
  const body =
    clauses.length === 1 ? clauses[0]! : `${clauses.slice(0, -1).join(", ")}, and ${clauses[clauses.length - 1]}`;
  return `In the pages that follow, ${body}.`;
}
