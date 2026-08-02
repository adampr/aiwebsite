// Grounded stated-staff extraction (ARCHITECTURE.md §5.17).
//
// The RFP reader (Turn 1) may report the client's stated organization size so
// the workspace can stop asking a question the document already answers. The
// model SELECTS, never authors: every field it returns is re-verified here
// against the exact fenced text it saw, and any failed check discards the
// WHOLE object — partial trust is never granted. The failure mode of every
// check is the safe one: the workspace falls back to asking, exactly as it
// did before this module existed.
//
// Pure functions only: imported by the server (brain.ts grounding) and the
// client (workspace range prefill), and unit-tested without a server by
// scripts/rfp-staff-count-tests.ts.

export type StatedStaff = {
  /** null = the RFP states a RANGE; quote then carries the range sentence. */
  count: number | null;
  /** ONE sentence copied verbatim from the document, capped at 300 chars. */
  quote: string;
  /** "users" only when the grounded quote itself says users/seats. */
  basis: "staff" | "users";
};

/** Above SMB scale a human should type the number, not an extractor. */
export const STATED_STAFF_MAX = 10_000;
const QUOTE_MAX = 300;

/**
 * Unicode format characters (bidi controls U+202E/U+2066..2069, zero-width
 * joiners — all \p{Cf}) plus C0 controls other than tab/LF/CR. They are legal
 * text nodes that React escaping does NOT neutralize; left in the quote they
 * can make the rendered evidence visually contradict the applied count.
 * Stripped from stored quotes AND inside the normalizer on both sides, so
 * documents that carry them innocently (PDF extraction emits them routinely)
 * still ground.
 */
const FORMAT_CHARS =
  /[\p{Cf}\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu;

/** NBSP, figure space, thin space, narrow NBSP: real thousands separators. */
const NUM_SPACES = "\\u00A0\\u2007\\u2009\\u202F";

/**
 * Normalize text for grounding comparison. The ONLY permitted loosening of
 * "verbatim" is thousands separators, and the separator class is deliberately
 * narrow:
 *
 * - comma directly against the next digit group ("1,200"), or comma followed
 *   by a LINE BREAK ("1,\n200" — PDF reflow splits exactly there);
 * - the Unicode number spaces (NBSP, figure, thin, narrow NBSP).
 *
 * NEVER a plain ASCII space, and never comma+space: "Phase 1 200 users" and
 * "Section 4, 120 staff" must not mint 1200/4120 — a merged number the
 * document never wrote would pass every downstream check in the unsafe,
 * no-question-asked direction. Merging runs BEFORE whitespace collapse so
 * the line-break case is still distinguishable from comma+space.
 */
export function normGroundText(s: string): string {
  return s
    .replace(FORMAT_CHARS, "")
    .replace(/(\d),(?=\d{3}(\D|$))/g, "$1")
    .replace(/(\d),[\r\n]\s*(?=\d{3}(\D|$))/g, "$1")
    .replace(new RegExp(`(\\d)[${NUM_SPACES}](?=\\d{3}(\\D|$))`, "g"), "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Population noun required in the quoted sentence: rejects "120-day transition". */
const POPULATION_NOUN =
  /\b(staff|employees?|headcount|users?|seats?|people|persons?|personnel|FTEs?|workforce)\b/i;

/**
 * The count must appear in the quote as a standalone token that is not a
 * price, a reference number, or a percentage: "$450 fee", "RFP #450" and
 * "450%" all share a sentence with a population noun easily enough.
 */
function countToken(count: number): RegExp {
  return new RegExp(`(^|[^\\d$€£#])${count}(?!\\s*%)(\\D|$)`);
}

/**
 * The explicit range stated in a quote, or null. Used both to validate the
 * range case (a quote that cannot yield a range is discarded, never shown)
 * and to pick the workspace prefill — the SAME parse, so the prefill can
 * never be a number the range check did not endorse. First match wins, and
 * both ends must be in bounds AND ascend: a founding year, a street address,
 * or "grow to 500 by 2028" never becomes an endpoint on its own.
 */
export function parseStaffRange(
  quote: string
): { lo: number; hi: number } | null {
  const n = normGroundText(quote);
  const m =
    /(?:^|[^\d$€£#])(\d{1,5})\s*(?:-|–|—|to|through)\s*(\d{1,5})(?!\s*%)(?=\D|$)/i.exec(
      n
    ) ??
    /\bbetween\s+(\d{1,5})\s+and\s+(\d{1,5})(?!\s*%)(?=\D|$)/i.exec(n);
  if (!m) return null;
  const lo = Number(m[1]);
  const hi = Number(m[2]);
  if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
  if (lo < 1 || hi > STATED_STAFF_MAX || hi <= lo) return null;
  return { lo, hi };
}

export type GroundResult = {
  staff: StatedStaff | null;
  /** Which check discarded the model's claim; for activity-meta tuning only. */
  discarded?: string;
};

/**
 * Verify the model's statedStaff claim against docText — the EXACT inner
 * string that sat between the fence tokens in the prompt (screened,
 * bracket-collapsed, sliced). Grounding against anything else would accept
 * quotes from text the model never saw, which is authored by definition.
 */
export function groundStatedStaff(
  raw: unknown,
  docText: string
): GroundResult {
  if (raw === null || raw === undefined) return { staff: null };
  if (typeof raw !== "object") return { staff: null, discarded: "shape" };
  const o = raw as Record<string, unknown>;

  // G1 — a quote exists. Trim/strip/cap BEFORE the other checks: a prefix of
  // a grounded substring is still grounded.
  if (typeof o.quote !== "string") return { staff: null, discarded: "G1" };
  const quote = o.quote.replace(FORMAT_CHARS, "").trim().slice(0, QUOTE_MAX);
  if (!quote) return { staff: null, discarded: "G1" };

  // G2 — the sentence exists verbatim in what the model saw. Injection-
  // dropped lines and text past the prompt slice can never ground.
  if (!normGroundText(docText).includes(normGroundText(quote)))
    return { staff: null, discarded: "G2" };

  // G6 — the quoted sentence is about a population.
  if (!POPULATION_NOUN.test(quote)) return { staff: null, discarded: "G6" };

  // G3 — basis is model-authored, so "users" must be visible in the grounded
  // quote itself; anything else coerces to "staff", the basis whose copy
  // states the assumption out loud.
  const basis: StatedStaff["basis"] =
    o.basis === "users" && /\b(users?|seats?)\b/i.test(quote)
      ? "users"
      : "staff";

  if (o.count === null) {
    // G7 — range case: the quote must yield an explicit in-bounds range,
    // else there is nothing honest to prefill and the object is worthless.
    if (!parseStaffRange(quote)) return { staff: null, discarded: "G7" };
    return { staff: { count: null, quote, basis } };
  }

  // G4 — an integer at SMB scale.
  if (
    typeof o.count !== "number" ||
    !Number.isInteger(o.count) ||
    o.count < 1 ||
    o.count > STATED_STAFF_MAX
  )
    return { staff: null, discarded: "G4" };

  // G5 — the digits were selected from the quoted line.
  if (!countToken(o.count).test(normGroundText(quote)))
    return { staff: null, discarded: "G5" };

  return { staff: { count: o.count, quote, basis } };
}
