// The ONE assembler for the submitter-facing refusal bodies the §5.16 work
// lanes compose themselves.
//
// Why it exists (2026-08-28 incident, dcollett@xl.net "XL Policy and
// Onboarding Plugin"): a program package with no architecture document was
// refused by email with the same six-sentence instruction paragraph printed
// TWICE. extract.ts answers both program document failures WITH that
// instruction as the failure's `message`, and the email lane appended the
// same constant after it to be helpful. Nothing was wrong with either half on
// its own; the defect was that no single place owned the finished body, so
// "say each thing once" was an invariant living in the heads of the ~30 call
// sites that assemble one.
//
// The first repair was a string equality at the one call site that had
// duplicated ("if the message is not already the constant, append it"). That
// is a claim about what a DIFFERENT module's constant happens to be, checked
// once, in one lane, with nothing pinning it. This module replaces the claim
// with a property: a block that has already been emitted is not emitted
// again, wherever it came from.
//
// ZERO IMPORTS, deliberately. It is a leaf so any module in the work graph
// can compose through it without a cycle: email-parse.ts already imports
// lint.ts, and names.ts exists precisely because a shared helper had to be
// lifted out of that pair. Copy constants stay owned by config.ts and are
// passed in.

export type RefusalBlock = string | null | undefined | false;

const PARAGRAPH_SEP = "\n\n";

/** Comparison key ONLY, never emitted: kept blocks are printed verbatim.
 * Whitespace collapsed and case folded, so a re-wrapped or re-cased copy of a
 * paragraph still counts as the same paragraph. */
function paragraphKey(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function paragraphsOf(block: string): string[] {
  // CRLF tolerated: composed bodies are LF, but this detector also runs over
  // finished bodies at the outbound seam, and inbound email text is CRLF.
  return block
    .split(/(?:\r?\n){2,}/)
    .map((piece) => piece.trim())
    .filter((piece) => piece !== "");
}

/** The paragraphs a finished body says more than once, in first-seen order.
 * Empty for every body this module composes; it is the detector the outbound
 * seam uses to prove that, and what a test asserts against. */
export function repeatedParagraphs(body: string): string[] {
  const seen = new Set<string>();
  const repeats = new Map<string, string>();
  for (const paragraph of paragraphsOf(body)) {
    const key = paragraphKey(paragraph);
    if (seen.has(key)) repeats.set(key, paragraph);
    else seen.add(key);
  }
  return [...repeats.values()];
}

/**
 * Join blocks into one body, dropping blanks and any paragraph already
 * emitted. First occurrence keeps its position and its exact bytes.
 *
 * A block holding several paragraphs is flattened and compared paragraph by
 * paragraph, so nesting one composed string inside another (which is what the
 * email lane's reject() does with composeRefusal's output) cannot smuggle a
 * repeat past the check.
 *
 * THE RULE IS EXACT MATCH AFTER NORMALIZATION, AND MUST STAY THAT WAY.
 * Similarity matching is refused on purpose: this lane's refusals routinely
 * share most of their words and differ in the one sentence that names the fix.
 * The ambiguity refusal prints "Several .md attachments could be the Skill's
 * document ... rename the right one to SKILL.md" beside "2 attachments were
 * over the 1 MB limit ... trim it or send it inside the package": high word
 * overlap, and the second paragraph carries the only statement of the real
 * reason. Dropping a paragraph the submitter needed is a worse failure than
 * printing one they have already read.
 */
export function composeParagraphs(blocks: readonly RefusalBlock[]): string {
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    if (typeof block !== "string") continue;
    for (const paragraph of paragraphsOf(block)) {
      const key = paragraphKey(paragraph);
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(paragraph);
    }
  }
  return kept.join(PARAGRAPH_SEP);
}

/** A refusal, in the order the submitter reads it. */
export interface RefusalParts {
  /** What the intake CLEANING removed before this refusal was reached
   * (§5.16 cleaning, 2026-08-29). First, ahead of the verdict lead: when the
   * package we read was one .env we then dropped, "your zip needs an
   * architecture document" is an accurate mechanism attached to the wrong
   * instruction, and the submitter goes looking for a file they did send. */
  cleaned?: string | null;
  /** What the package was READ as, when the refusal is a consequence of that
   * reading (kindVerdictSentence). The premise, never the fix. */
  lead?: string | null;
  /** What is wrong with THIS submission. The only required slot, and the one
   * the §5.15 ledger key is derived from. */
  diagnosis: string;
  /** Why a file that looked like the fix could not be used. */
  blocked?: string | null;
  /** The standing instruction for this failure class. Pass it
   * UNCONDITIONALLY: it is emitted at most once, and never when a slot above
   * already carries its words. */
  instruction?: string | null;
  /** Trailing evidence: file lists, candidate paths, size clauses. */
  evidence?: readonly RefusalBlock[];
}

/** Compose one refusal body from its slots. */
export function composeRefusal(parts: RefusalParts): string {
  const head: RefusalBlock[] = [
    parts.cleaned,
    parts.lead,
    parts.diagnosis,
    parts.blocked,
  ];
  const instruction =
    typeof parts.instruction === "string" && parts.instruction.trim() !== ""
      ? parts.instruction.trim()
      : null;
  // CONTAINMENT, and only for this slot. The instruction is standing
  // boilerplate whose whole job is to repeat, so dropping it when a block
  // above already carries its words cannot lose information: the submitter
  // has read those words. This is the half the 2026-08-28 equality check did
  // not have. It catches the shape where a diagnosis WRAPS the instruction
  // (the web lane's "<verdict sentence> <instruction>") as well as the shape
  // where it equals it, which is the one that shipped.
  const alreadySaid =
    instruction !== null &&
    head.some(
      (block) =>
        typeof block === "string" &&
        paragraphKey(block).includes(paragraphKey(instruction))
    );
  return composeParagraphs([
    ...head,
    alreadySaid ? null : instruction,
    ...(parts.evidence ?? []),
  ]);
}
