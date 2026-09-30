// RFP document titles (ARCHITECTURE.md §5.17.3).
//
// rfp_documents.title is what the /rfp list, the workspace header and the
// proposal (copied at creation) show. An upload with no typed title used to
// keep its raw filename stem ("Final_Acme_RFP_IT_Technology_Support"). Now
// the upload starts with a humanized filename and, once the reader has run,
// becomes "<client> · <the solicitation's own subject line>".
//
// Same select-never-author rule as staff-count.ts: the subject line is copied
// by the model and re-verified here against the exact fenced text it saw; a
// line that does not ground is dropped and the title falls back.
//
// Pure functions only, unit-tested by scripts/rfp-doc-title-tests.ts.

import { normGroundText, stripFormatChars } from "./staff-count";

export const DOC_TITLE_MAX = 300;
export const RFP_TITLE_MAX = 160;
/** What a pasted RFP with no typed title is called until it has been read. */
export const UNTITLED_RFP = "Untitled RFP";

const oneLine = (s: string): string =>
  stripFormatChars(s).replace(/\s+/g, " ").trim();

/** The upload types a title should not carry. Anything else after a dot is
 *  part of the name: "RFP v2.1", "Acme RFP No.5", "Budget.2026". */
const KNOWN_EXTENSION = /\.(?:pdf|docx|doc|txt|md|rtf|odt)$/i;

/**
 * A filename as a readable title: a known extension off, separators to
 * spaces, copy markers dropped. Never invents or drops a word the user's file carried
 * ("Final" stays): this is a fallback label, not a rewrite.
 */
export function humanizeFilename(name: string): string {
  const base = oneLine(name.replace(/^.*[\\/]/, ""))
    .replace(KNOWN_EXTENSION, "")
    .replace(/%20/gi, " ")
    .replace(/[_+]+/g, " ")
    // A hyphen between digits is a date or a range ("2026-09-18"); any other
    // hyphen in a filename is a word separator.
    .replace(/(?<!\d)-+|-+(?!\d)/g, " ")
    // "(1)", "[2]", "- Copy", "copy (3)" from a browser or file manager.
    .replace(/\s*[([]\d{1,3}[)\]]\s*$/g, "")
    .replace(/\s+copy(?:\s*[([]?\d{1,3}[)\]]?)?\s*$/i, "")
    .replace(/\s*[([]\d{1,3}[)\]]\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return base.slice(0, DOC_TITLE_MAX).trim() || UNTITLED_RFP;
}

/**
 * Verify the model's rfpTitle claim against docText, the EXACT inner string
 * that sat between the fence tokens (the same argument groundStatedStaff
 * takes). Returns the line as one line, or null: not a string, empty, no
 * letters, over 160 characters, or not present verbatim inside a SINGLE
 * line of what the model saw. Over-length is a discard, not a truncation:
 * half a title is worse than the fallback.
 *
 * Single line on purpose. The fenced text was screened for injection line
 * by line, so a "title" stitched across a line break can spell an
 * instruction no single line did, and would pass every other check here. A
 * genuine subject line wrapped over two lines is lost to the fallback; that
 * is the safe side. The caller (brain.ts readRfp) additionally runs the
 * injection screen over the grounded title itself; this module stays pure.
 */
export function groundRfpTitle(raw: unknown, docText: string): string | null {
  if (typeof raw !== "string") return null;
  // A heading copied with its markdown marker still grounds without it.
  const title = oneLine(raw).replace(/^#+\s*/, "");
  if (title.length < 3 || title.length > RFP_TITLE_MAX) return null;
  if (!/\p{L}/u.test(title)) return null;
  const needle = normGroundText(title);
  if (!docText.split(/\r?\n/).some((line) => normGroundText(line).includes(needle)))
    return null;
  return title;
}

/** Case- and punctuation-insensitive form for the "already says it" test. */
const fold = (s: string): string =>
  s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const GENERIC_SUBJECT =
  /^(?:(?:request|requests) for (?:proposals?|quotes?|quotations?|qualifications?|information|bids?)|rf[pqi]|invitation to bid|solicitation|(?:contract|due|date|deadline)\b.*)$/;

/**
 * The stored document title once the RFP has been read.
 *
 *   client + subject -> "Acme, NFP · IT & Technology Support Services"
 *   client only      -> "Acme, NFP · <fallback>" (the fallback alone when it
 *                       already starts with the client's name; "Acme, NFP ·
 *                       RFP" when there is no real fallback, never "· RFP"
 *                       twice)
 *   subject only     -> the subject
 *   neither          -> fallback (the humanized filename, or "Untitled RFP")
 *
 * The client name is not repeated when the subject already carries it. The
 * separator is a middle dot, and an em dash inside the client's own subject
 * line becomes one too (the owner bans em dashes in visible copy).
 */
export function composeDocTitle(input: {
  clientName: string | null;
  subject: string | null;
  fallback: string;
}): string {
  const tidy = (s: string | null): string =>
    oneLine(s ?? "")
      .replace(/\s*—\s*/g, " · ")
      .replace(/\s+–\s+/g, " · ")
      .replace(/^#+\s*/, "")
      .replace(/[\s:;,·-]+$/, "")
      .trim();
  const client = tidy(input.clientName);
  // A line that only says what KIND of document this is ("REQUEST FOR
  // PROPOSALS"), or a contract/date line, grounds fine and titles nothing.
  const rawSubject = tidy(input.subject);
  const subject = GENERIC_SUBJECT.test(fold(rawSubject)) ? "" : rawSubject;
  const cap = (s: string): string => s.slice(0, DOC_TITLE_MAX).trim();

  if (client && subject) {
    const c = fold(client);
    return cap(
      c && ` ${fold(subject)} `.includes(` ${c} `)
        ? subject
        : `${client} · ${subject}`
    );
  }
  if (client) {
    // The humanized filename (or a typed title) still says more than "RFP".
    const fallback = tidy(input.fallback);
    const c = fold(client);
    const f = fold(fallback);
    if (!f || f === fold(UNTITLED_RFP) || f === "rfp")
      return cap(/(?:^|\s)RFP$/i.test(client) ? client : `${client} · RFP`);
    if (c && (f === c || f.startsWith(`${c} `))) return cap(fallback);
    // A filename that names the client mid-string ("Final Acme RFP IT
    // Support"): keep what it adds ("IT Support") and say the client once,
    // properly spelled. Words are only ever removed, never invented.
    const clientWords = new Set(c.split(" ").filter((w) => w.length > 2));
    if (fallback.split(/\s+/).some((w) => clientWords.has(fold(w)))) {
      const rest = fallback
        .split(/\s+/)
        .filter(
          (w) =>
            !clientWords.has(fold(w)) &&
            !/^(?:final|draft|copy|rfp|rfq|rfi)$/.test(fold(w))
        )
        .join(" ");
      return cap(rest ? `${client} · ${rest}` : `${client} · RFP`);
    }
    return cap(`${client} · ${fallback}`);
  }
  if (subject) return cap(subject);
  return cap(oneLine(input.fallback)) || UNTITLED_RFP;
}

/**
 * Whether a stored title is still the automatic one. The title is not
 * flagged on the row, so a re-read infers it: "Untitled RFP" for a paste, or
 * the humanized name of the first file. A miss only means the title is left
 * as it is, which is the safe direction.
 */
export function isAutoTitle(title: string, sourceName: string | null): boolean {
  if (title === UNTITLED_RFP) return true;
  if (!sourceName) return false;
  const first = sourceName.split(" + ")[0] ?? "";
  return first !== "" && title === humanizeFilename(first);
}
