// Brief mode for the RFP read (ARCHITECTURE.md §5.17.17).
//
// A brief (staff notes on what the proposal must cover) has no section
// structure of its own. The reader returns structure [] for it, and the HOST
// decides here: the standard outline replaces the empty structure and every
// requirement is mapped onto it, so the workspace, draft-all and the
// generate route work exactly as they do for a structured RFP.
//
// Pure and client-safe; the injection screen is passed in by the caller
// (brain.ts), because the screen's module is server-only.

import { normGroundText, stripFormatChars } from "./staff-count";
import { OUTLINE_QUESTIONS_LABEL, STANDARD_OUTLINE, outlineLabelFor } from "./outline";

export type IntakeForm = "rfp" | "brief";

export const CONTACT_NAME_MAX = 120;
export const CONTACT_TITLE_MAX = 80;

export type BriefContact = { name: string; title: string | null };

/** A pasted text whose read found this few structure nodes is treated as a
 *  brief with a list in it, not as a document with sections. */
export const TINY_STRUCTURE_MAX = 2;

/**
 * Outline mode, decided after the reader's filters and caps: requirements
 * exist and either the structure is EMPTY, or NONE of the requirements'
 * labels names a structure node (the generate route's per-section filter
 * would then hand every section an empty ask list). The standard outline
 * replaces the structure and every requirement is mapped onto it, so the
 * document drafts. Questions and Clarifications is left out when no
 * requirement lands there: an empty questions section invites invented
 * client questions.
 *
 * Only PASTED text is a brief ("brief" tells the drafter to honor it as
 * XL.net staff's instructions); an uploaded file with no headings is still
 * the client's document and stays "rfp". No requirements is unchanged: a
 * read that found nothing keeps meaning that.
 */
export function applyBriefMode<
  R extends { structureLabel: string; kind: string },
>(
  parsed: {
    structure: { label: string; title: string }[];
    requirements: R[];
  },
  opts: { pasteOnly: boolean }
): {
  structure: { label: string; title: string }[];
  requirements: R[];
  intakeForm: IntakeForm;
} {
  if (parsed.requirements.length === 0) return { ...parsed, intakeForm: "rfp" };
  if (parsed.structure.length > 0) {
    const labels = new Set(parsed.structure.map((n) => n.label));
    const inside = parsed.requirements.filter((r) =>
      labels.has(r.structureLabel)
    ).length;
    // A pasted brief's own short numbered list ("Raise 2 questions: 1) ...
    // 2) ...") can come back as a two-node structure holding only those
    // items, with the brief's other points outside it. One pasted section
    // of a real RFP keeps every ask inside its node and is left alone.
    const listInsideBrief =
      opts.pasteOnly &&
      parsed.structure.length <= TINY_STRUCTURE_MAX &&
      parsed.requirements.length - inside > inside;
    if (inside > 0 && !listInsideBrief)
      return { ...parsed, intakeForm: "rfp" };
  }
  // A label that named one of the discarded nodes says nothing about the
  // outline ("1" was the list's first question, not Executive Summary), so
  // those requirements route by kind alone.
  const discarded = new Set(parsed.structure.map((n) => n.label));
  const requirements = parsed.requirements.map((r) => ({
    ...r,
    structureLabel: outlineLabelFor(
      discarded.has(r.structureLabel) ? "" : r.structureLabel,
      r.kind
    ),
  }));
  const used = new Set(requirements.map((r) => r.structureLabel));
  return {
    structure: STANDARD_OUTLINE.filter(
      (n) => n.label !== OUTLINE_QUESTIONS_LABEL || used.has(n.label)
    ).map((n) => ({ ...n })),
    requirements,
    intakeForm: opts.pasteOnly ? "brief" : "rfp",
  };
}

const oneLine = (s: string): string =>
  stripFormatChars(s).replace(/\s+/g, " ").trim();

/** Present verbatim inside this ONE line, as a whole word run: the same
 *  single-line rule as groundRfpTitle, so a value stitched across a line
 *  break cannot spell what no single screened line did. */
function groundsInLine(value: string, line: string): boolean {
  const needle = normGroundText(value);
  if (!needle) return false;
  const hay = normGroundText(line);
  let at = hay.indexOf(needle);
  while (at >= 0) {
    const before = hay.slice(0, at);
    const after = hay.slice(at + needle.length);
    if (!/[\p{L}\p{N}]$/u.test(before) && !/^[\p{L}\p{N}]/u.test(after))
      return true;
    at = hay.indexOf(needle, at + 1);
  }
  return false;
}

/**
 * Verify the reader's `contact` claim (SELECT, never author) against the
 * exact groundable text it saw. The name survives only when it is a single
 * line of at most 120 characters with a letter in it, present verbatim, and
 * clean under the injection screen; the title survives on the same terms (80
 * characters) AND on a line that also carries the name, or becomes null: a
 * title found elsewhere in the text is someone else's. Over-length is a
 * discard, never a truncation.
 */
export function groundContact(
  raw: unknown,
  docText: string,
  tripsScreen: (s: string) => boolean
): BriefContact | null {
  if (!raw || typeof raw !== "object") return null;
  const { name: rawName, title: rawTitle } = raw as {
    name?: unknown;
    title?: unknown;
  };
  if (typeof rawName !== "string" || /[\r\n]/.test(rawName.trim())) return null;
  const name = oneLine(rawName);
  if (name.length < 2 || name.length > CONTACT_NAME_MAX) return null;
  if (!/\p{L}/u.test(name)) return null;
  const nameLines = docText.split(/\r?\n/).filter((line) => groundsInLine(name, line));
  if (nameLines.length === 0 || tripsScreen(name)) return null;

  let title: string | null = null;
  if (typeof rawTitle === "string" && !/[\r\n]/.test(rawTitle.trim())) {
    const t = oneLine(rawTitle);
    if (
      t.length >= 2 &&
      t.length <= CONTACT_TITLE_MAX &&
      /\p{L}/u.test(t) &&
      nameLines.some((line) => groundsInLine(t, line)) &&
      !tripsScreen(t)
    )
      title = t;
  }
  // "Spiro Katerinis, CTO" with title "CTO" would print the title twice.
  if (title && name.toLowerCase().endsWith(`, ${title.toLowerCase()}`))
    return { name: name.slice(0, -(title.length + 2)).trim(), title };
  return { name, title };
}
