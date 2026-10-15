// Cover, letterhead and closing furniture: ONE author for the workspace
// sheets, resolve-draft (and so the gate) and both emitters (§5.17.5,
// §5.17.20). Pure and client-safe: no node:fs, no lookbehind, no imports
// beyond types, so workspace.tsx renders exactly the strings the files print.
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

/**
 * The whole cover lede, or undefined when the emitters compose today's RFP
 * form themselves (coverLedeParts). Byte-identical to the pre-round-32 lede
 * whenever no contact is stored:
 *   - rfp, no contact: undefined ("Prepared for <who> in response to ...")
 *   - rfp, contact:    "Prepared for <who>, Attention: <name>, <title>, in
 *                       response to the Request for Proposal."
 *   - brief, no contact or no who: "Prepared by XL.net for your review."
 *   - brief, contact:  "Prepared for <who>, Attention: <name>, <title>."
 */
export function coverLede(o: {
  intakeForm: string;
  who: string | null;
  contactName: string | null | undefined;
  contactTitle: string | null | undefined;
}): string | undefined {
  const attn = attention(o.contactName, o.contactTitle);
  const who = clean(o.who);
  if (o.intakeForm === "brief") {
    return attn && who
      ? sentence(`Prepared for ${who}, Attention: ${attn}`)
      : "Prepared by XL.net for your review.";
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
 *  by pricingParagraphIndex; the body alone when there is none. */
export function letterParagraphsWithPricing(body: string[], pricing: string | null): string[] {
  if (!pricing) return body;
  const at = pricingParagraphIndex(body.length);
  return [...body.slice(0, at), pricing, ...body.slice(at)];
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
