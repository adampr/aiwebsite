// XL.net's standard proposal outline (ARCHITECTURE.md §5.17.17).
//
// Client-safe and import-free: the workspace, the read worker and the tests
// all use it.

export type OutlineNode = { label: string; title: string };

/** XL.net's standard proposal outline, used when the intake text has no
 *  section structure of its own (a brief, notes, an email). Labels are bare
 *  numbers so the kicker renders "Section 1" over the title, as it does for
 *  a numbered RFP; the outline only ever replaces an EMPTY structure, so it
 *  never shares a document with client labels, and no label starts "__". */
export const STANDARD_OUTLINE: readonly OutlineNode[] = [
  { label: "1", title: "Executive Summary" },
  { label: "2", title: "Your Environment and What You Need" },
  { label: "3", title: "Scope of Services" },
  { label: "4", title: "Security and Included Tools" },
  { label: "5", title: "Cloud and On-Site Infrastructure" },
  { label: "6", title: "Projects and Transition" },
  { label: "7", title: "Service Delivery and Support" },
  { label: "8", title: "Agreement Terms" },
  { label: "9", title: "Questions and Clarifications" },
  { label: "10", title: "About XL.net" },
];

/** Where an unmapped statement lands: Scope of Services. */
export const OUTLINE_DEFAULT_LABEL = "3";
/** Where an unmapped question lands: Questions and Clarifications. */
export const OUTLINE_QUESTIONS_LABEL = "9";

/** The outline's titles as the reader is told them, one string, so the
 *  prompt and STANDARD_OUTLINE cannot drift. */
export const OUTLINE_TITLES_FOR_PROMPT = STANDARD_OUTLINE.map((n) => n.title).join("; ");

/** About XL.net: never takes a narrative title (round 32), so the company
 *  snapshot's picker keeps finding it by its standard title. */
export const OUTLINE_ABOUT_LABEL = "10";

/** The standard title for an outline label, or null for any other label. */
export function outlineDefaultTitle(label: string): string | null {
  return STANDARD_OUTLINE.find((n) => n.label === label)?.title ?? null;
}

/**
 * May a brief-mode section ask for, and take, a narrative title (round 32)?
 * Only an outline section other than About XL.net whose title is still
 * EXACTLY its standard one: a person's retitle, or a narrative title already
 * adopted, is never replaced. The letter's reserved label is no outline
 * label, so it never qualifies.
 */
export function narrativeTitleOpen(opts: {
  intakeForm: string;
  label: string;
  currentTitle: string;
}): boolean {
  if (opts.intakeForm !== "brief" || opts.label === OUTLINE_ABOUT_LABEL) return false;
  const standard = outlineDefaultTitle(opts.label);
  return standard !== null && opts.currentTitle === standard;
}

/** The landing guard: narrativeTitleOpen, plus a proposed title that is
 *  non-empty after the drafter's sanitation and actually different. */
export function mayAdoptNarrativeTitle(opts: {
  intakeForm: string;
  label: string;
  currentTitle: string;
  proposed: string | null | undefined;
}): boolean {
  const proposed = typeof opts.proposed === "string" ? opts.proposed.trim() : "";
  return proposed !== "" && proposed !== opts.currentTitle && narrativeTitleOpen(opts);
}

const fold = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

/** The outline label a requirement belongs under: its own label when that
 *  names an outline node BY TITLE (the reader is only ever told the titles;
 *  a bare "1" echoes the text's own numbering, never Executive Summary),
 *  else the kind's fallback. */
export function outlineLabelFor(raw: string, kind: string): string {
  const want = fold(raw);
  if (want) {
    const hit = STANDARD_OUTLINE.find((n) => fold(n.title) === want);
    if (hit) return hit.label;
  }
  return kind === "question" ? OUTLINE_QUESTIONS_LABEL : OUTLINE_DEFAULT_LABEL;
}
