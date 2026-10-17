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
import type { BrandedTableBlock, ResponseMatrixRow, StatTile } from "./content-model/blocks";
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
  // A brace never reaches the cover: the store side refuses them, so a
  // hand-stored {{att:N}} headline falls back rather than printing raw.
  if (headline && !/[{}]/.test(headline)) return headline;
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
 * en or em dash, an angle bracket, a curly brace, or stacked combining marks. ONE predicate
 * for both sides: brain.ts screenLetterThesis refuses the same at store, so a
 * thesis that stores always renders.
 */
export function thesisRefused(t: string): boolean {
  // A curly brace too (round 35 fix T1): no citation token on the closing.
  return /[0-9$\u2013\u2014<>{}]/.test(t) || hasStackedMarks(t);
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
  /** The proposal's attachment picks (§5.17.23): each row's subject and
   *  explanation go through resolveAttTokens HERE, the one lift every
   *  surface reads, so the gate scans what prints. Absent = no picks, so a
   *  stray token still strips. */
  picks?: readonly AttPickLike[];
  /** Counts the citations the rows' resolve stripped (rule D12). */
  tally?: AttTally;
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
      subject: resolveAttTokens(ans.subject, o.picks ?? [], o.tally),
      explanation: resolveAttTokens(ans.explanation, o.picks ?? [], o.tally),
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
  /** Round 35 (§5.17.23): the proposal ships attachments. "requested" when
   *  the client's request names a document of its own (a requirement of
   *  kind "attachment"), so "the supporting documents you requested" is
   *  true; "provided" when it does not. Absent or null, the sentence is
   *  exactly the round-34 one. */
  attached?: "requested" | "provided" | null;
}): string | null {
  const attached = o.attached ?? null;
  // With a pricing clause the sentence is already long: the attachments
  // then take a second sentence of their own (round 35 fix L1).
  const second = o.pricing && o.matrixKickers.length > 0;
  const tail = second
    ? ""
    : attached === "requested"
      ? ", with the supporting documents you requested attached"
      : attached === "provided"
        ? ", with our supporting documents attached"
        : "";
  const after =
    second && attached
      ? ` ${
          attached === "requested" ? "The supporting documents you requested are" : "Our supporting documents are"
        } attached and listed on the Supporting Documents page.`
      : "";
  if (!o.matrixKickers.length)
    // No questionnaire to describe: the attachments alone earn the
    // sentence, naming the sheet that lists them.
    return attached
      ? `${
          attached === "requested" ? "The supporting documents you requested are" : "Our supporting documents are"
        } attached, listed on the Supporting Documents page at the end of this response.`
      : null;
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
  return `In the pages that follow, ${body}${tail}.${after}`;
}

/* ---- Attachments and the Supporting Documents sheet (§5.17.23) --------- */

/** What the token resolver needs of a pick: its number. */
export type AttPickLike = { n: number };

/** The one model-citable attachment form, tolerant of case and inner
 *  spaces so a near-miss still resolves or strips rather than printing
 *  braces. The literal the prompt teaches is {{att:N}}. The same source as
 *  attachments.ts ATT_TOKEN_LOOSE_SOURCE (the citation remap the
 *  attachments write applies); the cover-letter tests pin the two equal. */
export const ATT_TOKEN_LOOSE_SOURCE = "\\{\\{\\s*att\\s*:\\s*(\\d{1,3})\\s*\\}\\}";

/** One citation site: an optional "Attachment "/"Attachments " the model
 *  wrote before the token (absorbed, so "Attachment {{att:2}}" prints
 *  "Attachment 2" once), any extra braces hugging it (a hugged token is
 *  refused: it strips), and the token. */
const ATT_SITE = new RegExp(`(\\battachments?[ \\t]+)?(\\{*)${ATT_TOKEN_LOOSE_SOURCE}(\\}*)`, "gi");
/** Whatever is left of a token the site pattern could not read ("{{att:2}",
 *  "{{att:-2}}", a non-ASCII digit): stripped too, so no printed string can
 *  ever hold "{{att" (rule D11 proves it). */
const ATT_REMNANT = /\{\{+\s*att[^{}\n]{0,24}\}*/gi;
/** The strip marker between the two passes (screened text never carries
 *  a NUL). */
const STRIP = "\u0000";

/** "Attachment N" in every surface's words. */
export const attachmentLabel = (n: number): string => `Attachment ${n}`;

/** What the resolver tallies across calls: citations stripped (T3). */
export type AttTally = { stripped: number };

const wordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/**
 * Close the gap one stripped citation leaves, looking ONLY at the few
 * characters on either side of it (never the rest of the string, so an
 * unrelated "( )", an indented line or a spaced comma elsewhere stays
 * byte for byte):
 *   - an emptied parenthetical goes with its opener ("(see ", "(in ",
 *     "(per ") and the one space before it;
 *   - a conjunction left dangling goes: before the site when punctuation
 *     or the end follows it, or when it joins a resolved "Attachment N";
 *     after the site when it joins the site to a resolved "Attachment N";
 *   - then the two sides meet with one space, none before punctuation or
 *     a line break, and a line's own indentation kept.
 */
function closeStrip(left: string, right: string): string {
  let L = left;
  let R = right;
  const po = /[ \t]*\([ \t]*(?:(?:see|in|per)[ \t]+)?$/i.exec(L);
  const pc = /^[ \t]*\)/.exec(R);
  if (po && pc) {
    L = L.slice(0, po.index);
    R = R.slice(pc[0].length);
  } else {
    const cl = /,?[ \t]+(?:and|or)[ \t]*$/i.exec(L);
    const endsHere = /^[ \t]*(?:[.,;:!?)\n]|$)/.test(R);
    const cr = /^[ \t]*(?:,[ \t]*(?:(?:and|or)[ \t]+)?|(?:and|or)[ \t]+)(?=Attachment \d)/i.exec(R);
    if (cl && (endsHere || /Attachment \d{1,3}$/.test(L.slice(0, cl.index)))) L = L.slice(0, cl.index);
    else if (cr && (L === "" || /[\s(]$/.test(L))) R = R.slice(cr[0].length);
  }
  const rt = R.replace(/^[ \t]+/, "");
  // At a line's start (or the string's), its indentation is the line's own.
  if (/(?:^|\n)[ \t]*$/.test(L)) return L + rt;
  const lt = L.replace(/[ \t]+$/, "");
  if (rt === "" || /^[\n.,;:!?)]/.test(rt)) {
    // "ISO, , and" -> "ISO, and": one mark where the citation stood.
    if (/[,;]$/.test(lt) && /^[,;.]/.test(rt)) return lt.slice(0, -1) + rt;
    return lt + rt;
  }
  return `${lt} ${rt}`;
}

/**
 * THE attachment-token resolver (§5.17.23), pure: every {{att:N}} whose N
 * is one of the proposal's picks becomes "Attachment N" (a space added
 * where a letter or digit touches it, an "Attachment " written before it
 * absorbed); any other (an invented number, a pick since removed, no picks
 * at all, a token hugged by extra braces, an unreadable remnant) is
 * STRIPPED, and only the few characters around the strip are tidied
 * (closeStrip). Text without a token is returned unchanged, byte for byte,
 * so a document that never cites one renders exactly as before. `tally`
 * counts the strips (rule D12). Applied at the one place each surface
 * takes its strings (resolve-draft for the gate and both files, the
 * workspace's sheet render for the screen), never per emitter.
 */
export function resolveAttTokens(text: string, picks: readonly AttPickLike[], tally?: AttTally): string {
  if (typeof text !== "string" || !text.includes("{{")) return text;
  const picked = new Set(picks.map((p) => p.n));
  let stripped = 0;
  let out = text.replace(
    ATT_SITE,
    (m: string, _word: string | undefined, open: string, digits: string, close: string, at: number, whole: string) => {
      const n = Number(digits);
      if (open || close || !picked.has(n)) {
        stripped++;
        return STRIP;
      }
      // A letter or digit touching the token, or a second token glued on,
      // gets one space; nothing else around the site changes.
      const end = at + m.length;
      const padAfter = wordChar(whole[end]) || whole.startsWith("{{", end);
      return `${wordChar(whole[at - 1]) ? " " : ""}${attachmentLabel(n)}${padAfter ? " " : ""}`;
    }
  );
  out = out.replace(ATT_REMNANT, () => {
    stripped++;
    return STRIP;
  });
  if (tally) tally.stripped += stripped;
  if (!stripped) return out;
  for (let i = out.indexOf(STRIP); i >= 0; i = out.indexOf(STRIP)) out = closeStrip(out.slice(0, i), out.slice(i + 1));
  return out;
}

/** Every string leaf of a stored or lifted block through `f`; the same
 *  object back (by identity, at every level) where nothing changes. */
function mapLeaves<T>(v: T, f: (s: string) => string): T {
  if (typeof v === "string") return f(v) as unknown as T;
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => {
      const y = mapLeaves(x, f);
      if (y !== x) changed = true;
      return y;
    });
    return (changed ? out : v) as unknown as T;
  }
  if (v && typeof v === "object") {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const y = mapLeaves(x, f);
      if (y !== x) changed = true;
      out[k] = y;
    }
    return (changed ? out : v) as T;
  }
  return v;
}

/**
 * A visual block with EVERY string resolved (T1, §5.17.23): cards, callouts,
 * tables, timelines, ledgers, stat tiles, an echo's titles, answers and
 * willSee, references. The same object back when nothing carries a token,
 * and every untouched part keeps its identity. Generic over the stored
 * DraftBlock and the content-model Block. Ids and kinds never hold "{{",
 * so they pass through unchanged.
 */
export function resolveBlockAtt<T>(block: T, picks: readonly AttPickLike[], tally?: AttTally): T {
  return mapLeaves(block, (s) => resolveAttTokens(s, picks, tally));
}

/** One picked attachment as the sheet prints it: its number, its title as
 *  denormalized at pick time, and the two library flags that add system
 *  copy (the confidentiality footnote, the redacted-sample note). */
export type AttachmentSheetPick = {
  n: number;
  title: string;
  confidential: boolean;
  redactedSample: boolean;
};

/** One requirement's mapping as every surface reads it (attachments.ts
 *  AttachmentMapValue, round 35 fix X1): a pick's n, 0 (explicitly not
 *  included), or several picks and/or the section of this response that
 *  answers the request. */
export type AttMapValueLike = number | { ns: number[]; section?: string };

/** A proposal's attachments as every surface reads them: picks in N order
 *  and the Attachments pane's per-requirement map (requirementId -> its
 *  AttMapValueLike). */
export type ProposalAttachmentsView = {
  picks: AttachmentSheetPick[];
  map: Record<string, AttMapValueLike>;
};

/**
 * The stored picks (attachments.ts readProposalAttachments) joined with
 * their library rows' flags: the one join gate-run.ts (so the gate and the
 * export) and the workspace both run. A pick whose row is missing keeps
 * printing under its denormalized title with neither flag. Null when
 * nothing is picked or mapped.
 */
export function attachmentsViewOf(
  state: { picks: readonly { docId: string; n: number; title: string }[]; map?: Readonly<Record<string, AttMapValueLike>> } | null | undefined,
  library: readonly { id: string; confidential: boolean; redactedSample: boolean }[]
): ProposalAttachmentsView | null {
  // A map with no picks (every requested document marked "not included")
  // still reaches the checks; the sheet itself needs a pick.
  if (!state || (!state.picks.length && !Object.keys(state.map ?? {}).length)) return null;
  const byId = new Map(library.map((d) => [d.id.toLowerCase(), d]));
  return {
    picks: state.picks.map((p) => {
      const d = byId.get(p.docId.toLowerCase());
      return { n: p.n, title: p.title, confidential: d?.confidential === true, redactedSample: d?.redactedSample === true };
    }),
    map: { ...(state.map ?? {}) },
  };
}

/** What the register reads of a requirement. */
export type AttachmentRequirementLike = { id: string; kind: string; text: string; ordinal?: number };

/** The Supporting Documents sheet's fixed system copy (§5.17.23). */
export const SUPPORTING_KICKER = "Attachments";
export const SUPPORTING_TITLE = "Supporting Documents";
export const SUPPORTING_REGISTER_HEAD = ["You requested", "Where it is"] as const;
export const SUPPORTING_LIST_CAPTION = "Documents attached to this response";
/** One column: each row is the "Attachment N - <title>" the register and
 *  the zip entries name (a narrow "Attachment" column wrapped its own
 *  word in the PDF). */
export const SUPPORTING_LIST_HEAD = ["Document"] as const;
export const SUPPORTING_NOT_INCLUDED = "Not included";
const SUPPORTING_INTRO_MAPPED =
  "Mapped to the supporting documents your request asks for. The attachments are provided separately with this response.";
const SUPPORTING_INTRO_LIST = "The attachments listed below are provided separately with this response.";

/** The sheet, resolved once: every string any surface prints on it. */
export type SupportingDocuments = {
  intro: string;
  /** One row per requirement of kind "attachment", in the client's order;
   *  [] when the request names none (the register is then omitted). */
  register: { requested: string; whereItIs: string }[];
  list: { n: number; title: string }[];
  /** The "provided in confidence" footnote, only when a confidential
   *  document is picked; else null. */
  confidentialLine: string | null;
  /** The note for samples with the client's details removed; else null. */
  redactedLine: string | null;
};

/** "1", "1 and 3", "1, 3 and 6". */
const numberList = (ns: readonly number[]): string => andList(ns.map(String));

/** A client requirement as the register's left cell prints it: one line,
 *  the dash tidy the cover lede applies (an em dash or a spaced en dash
 *  becomes " · "), so system furniture never carries a dash the style
 *  rules refuse. The words are the client's own. */
function registerLine(raw: string): string {
  return clean(raw)
    .replace(/\s*[—―⸺⸻﹘︱︲]\s*/g, " · ")
    .replace(/\s+–\s+/g, " · ")
    .trim();
}

/** "Attachment N - <title>", the register's mapped cell. */
export const attachmentRef = (p: { n: number; title: string }): string =>
  `${attachmentLabel(p.n)} - ${clean(p.title)}`;

/**
 * The Supporting Documents sheet (§5.17.23, the reference's p40 register),
 * or null when nothing is picked (every document without picks resolves
 * exactly as before). The register's WHERE IT IS cell for each requirement
 * of kind "attachment" prints, in order: every mapped pick as "Attachment
 * N - <title>" (ascending, "; " between), then "In this response -
 * Section <label>" when the mapping names the section that answers it
 * (the label as that section's sheet kicker prints it, `kicker`); with
 * neither, "Not included" (an explicit 0, or a request nobody mapped,
 * which the checks warn on when it is mandatory: rule D10). The
 * confidential footnote and the redacted-sample note are SYSTEM copy
 * naming numbers only.
 */
export function supportingDocumentsOf(o: {
  attachments: ProposalAttachmentsView | null | undefined;
  requirements: readonly AttachmentRequirementLike[];
  /** A section label as its sheet's kicker ("Section 4.2"); default
   *  sectionKicker (a real RFP's). */
  kicker?: (label: string) => string;
}): SupportingDocuments | null {
  const picks = [...(o.attachments?.picks ?? [])]
    .filter((p) => Number.isInteger(p.n) && p.n > 0 && clean(p.title) !== "")
    .sort((a, b) => a.n - b.n);
  if (!picks.length) return null;
  const byN = new Map(picks.map((p) => [p.n, p]));
  const map = o.attachments?.map ?? {};
  const reqs = (Array.isArray(o.requirements) ? o.requirements : [])
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r && r.kind === "attachment" && registerLine(r.text) !== "")
    .sort((a, b) => (a.r.ordinal ?? a.i) - (b.r.ordinal ?? b.i) || a.i - b.i)
    .map(({ r }) => r);
  const kicker = o.kicker ?? sectionKicker;
  const register = reqs.map((r) => {
    // attachments.ts stores the map's requirement ids lowercased.
    const key = Object.prototype.hasOwnProperty.call(map, r.id) ? r.id : String(r.id).toLowerCase();
    const v = Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
    const ns = typeof v === "number" ? [v] : v && typeof v === "object" && Array.isArray(v.ns) ? v.ns : [];
    const refs = [...new Set(ns)]
      .sort((a, b) => a - b)
      .flatMap((n) => {
        const pick = Number.isInteger(n) && n > 0 ? byN.get(n) : undefined;
        return pick ? [attachmentRef(pick)] : [];
      });
    const section =
      v && typeof v === "object" && typeof v.section === "string" ? clean(v.section).replace(/[{}]/g, "") : "";
    const cell = [...refs, ...(section ? [`In this response - ${kicker(section)}`] : [])];
    return { requested: registerLine(r.text), whereItIs: cell.length ? cell.join("; ") : SUPPORTING_NOT_INCLUDED };
  });
  const conf = picks.filter((p) => p.confidential).map((p) => p.n);
  const red = picks.filter((p) => p.redactedSample).map((p) => p.n);
  return {
    intro: register.length ? SUPPORTING_INTRO_MAPPED : SUPPORTING_INTRO_LIST,
    register,
    list: picks.map((p) => ({ n: p.n, title: clean(p.title) })),
    confidentialLine: conf.length
      ? conf.length === 1
        ? `${attachmentLabel(conf[0]!)} is provided in confidence, for your evaluation only.`
        : `Attachments ${numberList(conf)} are provided in confidence, for your evaluation only.`
      : null,
    redactedLine: red.length
      ? red.length === 1
        ? `${attachmentLabel(red[0]!)} is a sample from another engagement, with that client's details removed.`
        : `Attachments ${numberList(red)} are samples from other engagements, with those clients' details removed.`
      : null,
  };
}

/** The letter roadmap's attachment clause (letterRoadmapSentence `attached`). */
export function roadmapAttached(sd: SupportingDocuments | null): "requested" | "provided" | null {
  if (!sd) return null;
  return sd.register.length ? "requested" : "provided";
}

type TableBody = Omit<BrandedTableBlock, "id" | "sectionId" | "ordinal" | "cites" | "generatedBy" | "editedByHuman">;

/** The sheet's two tables as branded-table bodies, built ONCE for the
 *  screen and both emitters (the summary sheet's cost-index precedent):
 *  the register (null when the request names no document) and the
 *  numbered list. */
export function supportingTables(sd: SupportingDocuments): { register: TableBody | null; list: TableBody } {
  return {
    register: sd.register.length
      ? {
          kind: "table",
          caption: null,
          columns: SUPPORTING_REGISTER_HEAD.map((header) => ({ header, align: "left" as const })),
          rows: sd.register.map((r) => [r.requested, r.whereItIs]),
          emphasizeLastRow: false,
        }
      : null,
    list: {
      kind: "table",
      caption: SUPPORTING_LIST_CAPTION,
      columns: SUPPORTING_LIST_HEAD.map((header) => ({ header, align: "left" as const })),
      rows: sd.list.map((p) => [attachmentRef(p)]),
      emphasizeLastRow: false,
    },
  };
}

/* ---- The submission package (format=zip, §5.17.23) --------------------- */

/** A name as a zip entry may carry it: no path or reserved characters, a
 *  colon kept readable as a hyphen ("ISO 27001:2022" -> "27001-2022", the
 *  reference package's own spelling), dashes plain, whitespace collapsed,
 *  no trailing dot or space, capped. */
export function packageNamePart(raw: string, max = 120): string {
  const s = String(raw ?? "")
    .normalize("NFC")
    .replace(/:/g, "-")
    .replace(/[–—―]/g, "-")
    .replace(/[\\/*?"<>|\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const cut = s.length > max ? s.slice(0, max) : s;
  return cut.replace(/[.\s]+$/, "").trim();
}

/** The file extension a library media type ships under. */
export function packageExt(media: string): string {
  const m = String(media ?? "").toLowerCase();
  if (m.includes("wordprocessingml") || m.endsWith("/docx")) return "docx";
  if (m.includes("pdf")) return "pdf";
  return "bin";
}

/** The package's entry names, in zip order: the folder, the "00" pair
 *  (PDF, then Word) and each pick in N order. One function, so the route
 *  and the read-back test cannot disagree. */
export function packageEntryNames(o: {
  clientName: string | null | undefined;
  attachments: readonly { n: number; title: string; media: string }[];
}): { folder: string; pdf: string; docx: string; attachments: string[] } {
  const who = packageNamePart(o.clientName ?? "", 80);
  const base = who ? `00 - XL.net ${who} Proposal` : "00 - XL.net Proposal";
  const folder = who ? `${who} - XL.net Proposal and Supporting Documents` : "XL.net Proposal and Supporting Documents";
  return {
    folder,
    pdf: `${base}.pdf`,
    docx: `${base}.docx`,
    attachments: [...o.attachments]
      .sort((a, b) => a.n - b.n)
      .map((a) => {
        const t = packageNamePart(a.title);
        return `${attachmentLabel(a.n)}${t ? ` - ${t}` : ""}.${packageExt(a.media)}`;
      }),
  };
}
