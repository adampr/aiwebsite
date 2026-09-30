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
 * What makes a sentence worth scanning for staff evidence. Wider than
 * POPULATION_NOUN, which stays the strict G6 gate for model-selected quotes:
 * "has a team of 300" and "85 team members" are evidence (and a conflict)
 * even though neither would ground a statedStaff claim.
 */
const MENTION_NOUN =
  /\b(staff|employees?|headcount|users?|seats?|people|persons?|personnel|FTEs?|workforce|team|members?)\b/i;

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

// ---------------------------------------------------------------------------
// Deterministic staff evidence (ARCHITECTURE.md §5.17.3).
//
// The model-selected statedStaff above only survives for an exact digit count
// or an explicit range. "a small team of fewer than 10 employees" is neither,
// so the workspace used to ask the fully-managed-users question bare, with the
// answer sitting in the document. Everything below is a plain scan, NO model:
// it finds the sentences that talk about how many people the client has so
// the question can show them, and it decides the one case where no question
// is needed at all (the client fits inside the monthly minimum).
//
// Precision over recall, in a fixed direction: a missed mention only means
// the old plain question; a false LOW count would misprice. So a number only
// counts when it sits against a population noun in a known pattern, and a
// bare count never triggers the minimum assumption: only an upper bound
// ("fewer than 10", "up to 12") or an explicit range can.
// ---------------------------------------------------------------------------

/** A sentence of the RFP that talks about how many people the client has.
 *  Verbatim (whitespace collapsed), FORMAT_CHARS stripped, <= 300 chars. */
export type StaffMention = { quote: string };

/** For callers outside this module that store or show untrusted one-liners. */
export function stripFormatChars(s: string): string {
  return s.replace(FORMAT_CHARS, "");
}

const NUM = "(\\d{1,3}(?:,\\d{3})+|\\d{1,5})";

/**
 * Words that make the number after them a label, not a quantity: "Office 365
 * users", "Phase 2 staff", "September 18 staff meeting".
 */
const LABEL_BEFORE =
  "(?:office|microsoft|windows|server|version|phase|section|item|tier|level|step|exhibit|appendix|attachment|article|page|question|no|number|suite|floor|room|grade|type|option|year|fy|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)";

/**
 * What may NOT sit directly before a people-count: another digit, a currency
 * or reference sigil, a letter ("M365"), a letter-hyphen ("COVID-19"), the
 * tail of a decimal/date/time/ratio ("4.2", "24/7", "5:00"), the far end of a
 * range, a digit-space ("Phase 1 200 users" must not yield 200 any more than
 * 1200), or a label word.
 */
const PRE =
  "(?<![\\d$€£#A-Za-z])(?<![A-Za-z][-–])(?<!\\d[.,/:])(?<!\\d\\s?[-–—]\\s?)(?<!\\d\\s)" +
  `(?<!\\b${LABEL_BEFORE}\\.?\\s)`;

/** What may NOT follow: more digits, a decimal/ratio/time tail, a space-digit
 *  group, a percent sign, an ordinal suffix, "-day", or an unparsed range. */
const POST =
  "(?!\\d)(?![.,/:]\\d)(?!\\s\\d)(?!\\s*%)(?!(?:st|nd|rd|th)\\b)(?![-–][A-Za-z])(?!\\s*[-–—]\\s*\\d)";

const UPPER_WORDS =
  "fewer\\s+than|less\\s+than|under|below|up\\s+to|no\\s+more\\s+than|not\\s+more\\s+than|at\\s+most|(?:a\\s+)?max(?:imum)?\\s+of";
const LOWER_WORDS =
  "more\\s+than|over|at\\s+least|(?:a\\s+)?min(?:imum)?\\s+of|exceed(?:s|ing)?|upwards\\s+of";

/**
 * One number expression. Groups, relative to `base`: +0 whole, +1 bound
 * words, +2 a, +3 b (range end), +4 suffix, +5/+6 the "between a and b" pair.
 */
const NUMEXPR =
  `((?:\\b(${UPPER_WORDS}|${LOWER_WORDS})\\s+)?${PRE}${NUM}` +
  `(?:\\s*(?:-|–|—|to|through)\\s*${NUM})?${POST}` +
  `(\\s*\\+|\\s+or\\s+(?:fewer|less|more)\\b)?` +
  `|\\bbetween\\s+${PRE}${NUM}\\s+and\\s+${NUM}${POST})`;

/** A number followed by one of these is a duration, a score or a place count. */
const UNIT_VETO =
  "(?!\\s*(?:years?|days?|hours?|months?|weeks?|minutes?|times|points?|pages?|references?|business|locations?|offices?|sites?|percent|visits?)\\b)";

/** Qualifiers allowed between the number and its noun. A closed list on
 *  purpose: "3 years of staff experience" must not read as 3 staff. */
const QUALIFIERS =
  "(?:(?:(?:full|part)[- ]time|total|current|active|internal|remote|on-?site|in-office|office|computer|network|named|licensed|concurrent|permanent|salaried|contracted|contract|clinical|administrative|professional|technical|support|additional|regular|seasonal|temporary|paid|FTE|are)\\s+){0,3}";

const COUNT_NOUN =
  "(staff(?:\\s+members?)?|team\\s+members?|employees?|(?:end[- ])?users?|seats?|people|persons?|personnel|FTEs?|(?:full|part)[- ]time(?:rs)?)";

/** The noun is an adjective here ("10 staff hours", "4 Staff Qualifications"). */
const NOUN_VETO =
  "\\b(?![- ](?:hours?|days?|weeks?|months?|years?|minutes?|training|meetings?|sessions?|stories|groups?|manuals?|guides?|references?|resumes?|surveys?|interviews?|time|level|experience|qualifications?|requirements?|augmentation|development|responsibilities|roles?|positions?)\\b)";

const APPROX = "(?:(?:approximately|approx\\.?|about|around|roughly|nearly|some|just)\\s+)?";

/** "<N> employees", "fewer than 10 employees", "100-120 staff". */
const P_NUM_NOUN = new RegExp(
  `${NUMEXPR}\\s+${QUALIFIERS}${COUNT_NOUN}${NOUN_VETO}`,
  "gi"
);
/** Noun-first patterns; the number expression is always the last thing consumed. */
const P_NOUN_NUM = [
  // "a staff of 300 to 350", "a small team of 8"
  `\\b(?:staff|team|workforce|headcount)(?:\\s+size)?\\s+of\\s+${APPROX}${NUMEXPR}${UNIT_VETO}`,
  // "Current Staff: 200 - 250", "Number of employees: 45"
  `\\b(?:staff|employees|users|seats|headcount|FTEs?|personnel|people|workforce)(?:\\s+(?:size|count|total))?(?:\\s*\\([^)]{0,30}\\))?\\s*[:=]\\s*${APPROX}${NUMEXPR}${UNIT_VETO}`,
  // "headcount is 120", "the number of users is about 60"
  `\\b(?:headcount|(?:staff|employee|user|seat)\\s+count|number\\s+of\\s+(?:staff|employees|users|seats|people|FTEs))\\s+(?:is|are|was|totals?|stands\\s+at)\\s+${APPROX}${NUMEXPR}${UNIT_VETO}`,
  // A table row whose cells were joined: "Current Staff 200 - 250"
  `^[#\\s]*(?:(?:current|total|approximate|number\\s+of|no\\.\\s+of|full[- ]time|active|supported)\\s+)*(?:staff|employees|users|seats|headcount|FTEs?|personnel|workforce)(?:\\s+(?:size|count|total))?\\s+${NUMEXPR}\\s*$`,
].map((src) => new RegExp(src, "gi"));

/** A parsed people-count. `upper` = the statement CAPS the population (an
 *  upper-bound phrase or an explicit range), so `hi` is a ceiling. */
type Signal = {
  at: number;
  /** End of the match (number-first: past the noun), in scanText space. */
  end: number;
  /** The matched text, qualifiers and noun included. */
  span: string;
  hi: number;
  upper: boolean;
};

/** Digits as written. A bare 19xx/20xx is a year, never a headcount; the
 *  comma form ("2,000") is how a document writes two thousand people. */
function tokenValue(tok: string | undefined): number | null {
  if (!tok) return null;
  if (/^(?:19|20)\d\d$/.test(tok)) return null;
  const n = Number(tok.replace(/,/g, ""));
  return Number.isInteger(n) && n >= 1 && n <= STATED_STAFF_MAX ? n : null;
}

function readNumExpr(
  m: RegExpExecArray,
  base: number
): { hi: number; upper: boolean } | null {
  if (m[base + 5] !== undefined) {
    const lo = tokenValue(m[base + 5]);
    const hi = tokenValue(m[base + 6]);
    return lo !== null && hi !== null && hi > lo ? { hi, upper: true } : null;
  }
  const a = tokenValue(m[base + 2]);
  if (a === null) return null;
  if (m[base + 3] !== undefined) {
    const b = tokenValue(m[base + 3]);
    return b !== null && b > a ? { hi: b, upper: true } : null;
  }
  const bound = (m[base + 1] ?? "").toLowerCase().replace(/\s+/g, " ");
  const suffix = (m[base + 4] ?? "").toLowerCase();
  if (/fewer|less/.test(suffix)) return { hi: a, upper: true };
  if (suffix) return { hi: a, upper: false }; // "10+", "10 or more"
  if (/^(fewer than|less than|under|below)$/.test(bound))
    return a > 1 ? { hi: a - 1, upper: true } : null;
  if (bound && new RegExp(`^(?:${UPPER_WORDS})$`).test(bound))
    return { hi: a, upper: true };
  if (/^(more than|over|upwards of|exceed)/.test(bound))
    return { hi: a + 1, upper: false };
  return { hi: a, upper: false };
}

/** Scan text: FORMAT_CHARS out, number-space thousands grouping rewritten to
 *  the comma form (so "1 200" is one token, exactly as normGroundText reads
 *  it), NFKC (fullwidth digits "２００" read as 200; it runs AFTER the
 *  number-space rewrite because NFKC folds those spaces to a plain one),
 *  then whitespace collapsed. Scan-only: quotes stay verbatim. */
function scanText(s: string): string {
  return s
    .replace(FORMAT_CHARS, "")
    .replace(new RegExp(`(\\d)[${NUM_SPACES}](?=\\d{3}(\\D|$))`, "g"), "$1,")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every people-count in one sentence, in order, one per number expression. */
function signalsOf(sentence: string): Signal[] {
  const s = scanText(sentence);
  const out: Signal[] = [];
  const add = (
    at: number,
    end: number,
    span: string,
    sig: { hi: number; upper: boolean } | null
  ) => {
    if (sig && !out.some((o) => o.at === at))
      out.push({ at, end, span, ...sig });
  };
  P_NUM_NOUN.lastIndex = 0;
  for (let m = P_NUM_NOUN.exec(s); m; m = P_NUM_NOUN.exec(s)) {
    // A heading's own number ("4 Staff Qualifications") opens the line and
    // is followed by a capitalized noun; a sentence writes the noun lower.
    const opensLine = /^[#\s]*$/.test(s.slice(0, m.index));
    const noun = m[8] ?? "";
    if (opensLine && /^[A-Z][a-z]/.test(noun)) continue;
    add(m.index, m.index + m[0].length, m[0], readNumExpr(m, 1));
  }
  for (const re of P_NOUN_NUM) {
    re.lastIndex = 0;
    for (let m = re.exec(s); m; m = re.exec(s)) {
      const expr = m[1] ?? "";
      // NUMEXPR is the last consuming piece of every noun-first pattern
      // (the table-row form allows only trailing spaces after it).
      const end = m.index + m[0].trimEnd().length;
      add(end - expr.length, end, m[0], readNumExpr(m, 1));
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Sentences about the RESPONDING vendor, not the client: "firms with fewer
 * than 10 employees will not be considered", "assign up to 3 staff". Reading
 * one as the client's size is the false-LOW direction, so the whole sentence
 * is skipped.
 */
const VENDOR_CUE =
  /\b(vendors?|bidders?|proposers?|respondents?|offerors?|contractors?|subcontractors?|consultants?|service\s+providers?|MSPs?|your|key\s+personnel|references?|resumes?|proposed)\b/i;

/** Sentence boundary: terminal punctuation, whitespace, then a capital.
 *  Initials and common abbreviations ("W. Belmont", "approx. 45") hold. */
const SENTENCE_SPLIT =
  /(?<=[.!?]["”)]?)(?<!\b\p{Lu}\.)(?<!\b(?:[Aa]pprox|[Ee]st|[Nn]o|[Ii]nc|[Aa]ve|[Ss]t|[Dd]r|[Mm]rs?|[Mm]s|[Ll]td|[Cc]o|[Cc]orp|vs|etc)\.)\s+(?=["“(]?\p{Lu})/u;

/** Quote form of a sentence: whitespace collapsed to single spaces, but the
 *  Unicode number spaces are kept so the quote still grounds under
 *  normGroundText against the text it was cut from. */
function quoteText(s: string): string {
  return s
    .replace(new RegExp(`[^\\S${NUM_SPACES}]+`, "g"), " ")
    .replace(/^(?:#+|[-*•·])\s+/, "")
    .trim();
}

/** A <= QUOTE_MAX window of a long sentence around one signal, cut only at
 *  spaces so no number is ever truncated into a different number. */
function windowAround(s: string, at: number): string | null {
  let start = Math.max(0, at - 120);
  if (start > 0) {
    const sp = s.indexOf(" ", start);
    if (sp < 0 || sp >= at) return null;
    start = sp + 1;
  }
  let end = Math.min(s.length, start + QUOTE_MAX);
  if (end < s.length) {
    const sp = s.lastIndexOf(" ", end);
    if (sp <= at) return null;
    end = sp;
  }
  return s.slice(start, end).trim();
}

/** A line that breaks right before its number: "We have fewer than\n10". */
const WRAP_TAIL =
  /\b(?:than|under|below|over|about|approximately|around|least|most|have|has|employs?|of|to|and)$/i;

/**
 * Re-join wrapped lines: a line that does not end a sentence, followed by
 * one that starts lowercase, is one sentence; "Current Staff:" followed by a
 * line opening with a digit is one label; and a line ending on a word that
 * wants a number ("fewer than", "have", "and"), followed by one opening with
 * a digit that is not a list marker, is one sentence.
 */
function joinLines(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const prev = lines[lines.length - 1];
    if (
      prev !== undefined &&
      ((!/[.!?:;]$/.test(prev) && /^\p{Ll}/u.test(line)) ||
        (/:$/.test(prev) && prev.length <= 80 && /^\d/.test(line)) ||
        (WRAP_TAIL.test(prev) &&
          /^\d/.test(line) &&
          !/^\d{1,3}[.)]\s/.test(line)))
    )
      lines[lines.length - 1] = `${prev} ${line}`;
    else lines.push(line);
  }
  return lines;
}

/**
 * Deterministic scan (NO model): every sentence/line in docText that carries
 * a population noun AND a people-count signal. Document order, deduped by
 * normGroundText, at most `max` (default 5).
 *
 * When more than `max` exist, the mention carrying the LARGEST count always
 * survives the cut (it takes the last slot): minimumAssumption only sees what
 * is returned here, and dropping the one sentence that says "200 users" would
 * turn a conflict into a silent minimum.
 */
export function staffMentions(docText: string, max = 5): StaffMention[] {
  const cap = Number.isInteger(max) ? Math.min(Math.max(max, 1), 20) : 5;
  const text = docText
    .replace(FORMAT_CHARS, "")
    // PDF reflow splits "1,\n200" exactly there; normGroundText merges it.
    .replace(/(\d),[\r\n]\s*(?=\d{3}(\D|$))/g, "$1,");

  const lines = joinLines(text);

  const found: { quote: string; hi: number }[] = [];
  const seen = new Set<string>();
  const push = (quote: string) => {
    if (!quote || quote.length > QUOTE_MAX) return;
    if (!MENTION_NOUN.test(quote)) return;
    // Re-scan the FINAL quote: consumers only ever get the quote, so it must
    // reproduce the signal on its own.
    const sigs = signalsOf(quote);
    if (!sigs.length) return;
    const key = normGroundText(quote);
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ quote, hi: Math.max(...sigs.map((s) => s.hi)) });
  };

  for (const line of lines) {
    for (const part of line.split(SENTENCE_SPLIT)) {
      const sentence = quoteText(part);
      if (!sentence || VENDOR_CUE.test(sentence)) continue;
      if (!MENTION_NOUN.test(sentence)) continue;
      if (sentence.length <= QUOTE_MAX) {
        push(sentence);
        continue;
      }
      // Long sentence: one window per signal, so a late "200 users" in the
      // same sentence still surfaces as its own mention.
      const s = scanText(sentence) === sentence ? sentence : null;
      if (!s) continue;
      for (const sig of signalsOf(s)) {
        const w = windowAround(s, sig.at);
        if (w) push(w);
      }
    }
  }

  if (found.length <= cap) return found.map((f) => ({ quote: f.quote }));
  const kept = found.slice(0, cap);
  const top = found.reduce((a, b) => (b.hi > a.hi ? b : a));
  if (!kept.includes(top)) kept[cap - 1] = top;
  return kept.map((f) => ({ quote: f.quote }));
}

const P_BOUND_BEFORE = new RegExp(
  `\\b(${UPPER_WORDS})\\s+${PRE}${NUM}${POST}${UNIT_VETO}`,
  "i"
);
const P_BOUND_AFTER = new RegExp(
  `${PRE}${NUM}${POST}\\s+or\\s+(?:fewer|less)\\b`,
  "i"
);

/**
 * The inclusive upper bound a quote states, or null: "fewer than 10" / "less
 * than 10" / "under 10" / "below 10" -> 9; "up to 12" / "no more than 12" /
 * "at most 12" / "a maximum of 12" / "12 or fewer" -> 12. DIGITS ONLY: number
 * words are not converted, the same rule the reader prompt and G5 follow
 * (a word-number bound would be honored while a word-number conflict stayed
 * invisible). Same token hygiene as countToken (not $, #, %), plus years.
 * The earliest bound in the quote wins.
 */
export function parseStaffBound(quote: string): { max: number } | null {
  const s = scanText(quote);
  const before = P_BOUND_BEFORE.exec(s);
  const after = P_BOUND_AFTER.exec(s);
  const useBefore = before && (!after || before.index <= after.index);
  if (useBefore) {
    const n = tokenValue(before[2]);
    if (n === null) return null;
    const strict = /^(fewer|less|under|below)/i.test(before[1]);
    if (strict) return n > 1 ? { max: n - 1 } : null;
    return { max: n };
  }
  if (after) {
    const n = tokenValue(after[1]);
    return n === null ? null : { max: n };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Conflict scan: does the text show a population LARGER than a bound?
//
// Deliberately loose, in the one safe direction: a hit only ever turns "make
// the minimum the primary answer" back into the plain question. So it reads
// what the mention scanner refuses to: year-shaped and six-digit counts,
// space- or dot-grouped thousands, "1.2k", number words of scale, and people
// nouns outside the population list ("60 attorneys").
// ---------------------------------------------------------------------------

/** People nouns, listed and unlisted. Workstations, mailboxes and seats are
 *  things, not people, and are left out on purpose. */
const PEOPLE =
  "(?:staff(?:\\s+members?)?|team\\s+members?|employees?|(?:end[- ])?users?|people|persons?|personnel|FTEs?|workers?|members?|attorneys?|lawyers?|paralegals?|clinicians?|physicians?|doctors?|nurses?|therapists?|teachers?|faculty|students?|volunteers?|contractors?|technicians?|engineers?|associates?|agents?|officers?|individuals?)";

/** A word that may NOT sit between a number and its people noun: a unit, a
 *  thing, or a function word (which starts a new phrase). */
const NOT_BETWEEN =
  "(?:years?|days?|hours?|months?|weeks?|minutes?|seconds?|times|points?|pages?|percent|business|locations?|offices?|sites?|branch(?:es)?|buildings?|floors?|states?|countries|cities|counties|servers?|workstations?|computers?|devices?|laptops?|desktops?|printers?|phones?|licen[cs]es?|references?|visits?|tickets?|of|for|to|in|on|at|per|by|from|and|or|the|a|an|with|where|when|while|that|which|who|is|are|was|were|will|shall|must|may)";
const BETWEEN = `(?:\\s+(?!${NOT_BETWEEN}\\b)[A-Za-z][A-Za-z-]*){0,2}`;
const PEOPLE_VETO =
  "\\b(?![- ](?:hours?|days?|weeks?|months?|years?|minutes?|training|meetings?|sessions?|stories|manuals?|guides?|references?|resumes?|surveys?|interviews?|time|level|experience|qualifications?|requirements?|augmentation|development|responsibilities|roles?|positions?|licen[cs]es?|accounts?|devices?|mailboxes)\\b)";
const LOOSE_TAIL =
  "(?!\\d)(?![.,/:]\\d)(?!\\s\\d)(?!\\s*%)(?!(?:st|nd|rd|th)\\b)(?![-–][A-Za-z])";

/** "85 workers", "2000 employees", "250000 staff", "60 attorneys". */
const P_CONFLICT_NUM = new RegExp(
  `${PRE}(\\d{1,3}(?:,\\d{3})+|\\d{1,9})\\+?${LOOSE_TAIL}${BETWEEN}\\s+${PEOPLE}${PEOPLE_VETO}`,
  "gi"
);
/** "1 200 employees", "1.200 employees": grouped thousands, any value. */
const P_CONFLICT_GROUPED = new RegExp(
  `${PRE}\\d{1,3}(?:[ .]\\d{3})+(?!\\d)${BETWEEN}\\s+${PEOPLE}${PEOPLE_VETO}`,
  "i"
);
/** "1.2k employees". */
const P_CONFLICT_K = new RegExp(
  `(?<![\\d$€£#A-Za-z.,])\\d{1,3}(?:\\.\\d+)?\\s?k\\b${BETWEEN}\\s+${PEOPLE}${PEOPLE_VETO}`,
  "i"
);
/** "team of 300", "headcount is 1950", "Staff: 2010", "company size is 400". */
const P_CONFLICT_NOUN = new RegExp(
  "\\b(?:staff|team|workforce|headcount|employees|personnel|users|(?:company|organi[sz]ation|agency|staff|team)\\s+size|number\\s+of\\s+(?:staff|employees|users|people|FTEs))" +
    "(?:\\s+(?:size|count|total))?(?:\\s+(?:of|is|are|was|totals?|stands\\s+at)\\s+|\\s*[:=]\\s*)" +
    `${APPROX}(?:(?:over|under|more\\s+than|nearly|almost|up\\s+to)\\s+)?` +
    `(\\d{1,3}(?:,\\d{3})+|\\d{1,9})${LOOSE_TAIL}(?!\\s*[-–—]\\s*\\d)${UNIT_VETO}`,
  "gi"
);
const P_CONFLICT_OF_US = /(?<![\d$€£#.,])(\d{1,9})\s+of\s+us\b/gi;

/** Number WORDS of scale. Digits-only is the rule for a bound (see
 *  parseStaffBound); a word-number conflict must still be visible. */
const SCALE =
  "(?:hundreds?|thousands?|dozens?|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)";
const P_SCALE = [
  // "two hundred employees", "eighty-five people", "hundreds of staff"
  `\\b${SCALE}\\b(?:-[a-z]+)?(?:\\s+of)?${BETWEEN}\\s+${PEOPLE}${PEOPLE_VETO}`,
  // "a workforce of two hundred", "a staff of approximately sixty"
  `\\b(?:staff|team|workforce|headcount|employees|size)\\s+(?:of|is|are)\\s+(?:[a-z]+\\s+){0,3}?${SCALE}\\b`,
  `\\b${SCALE}\\s+of\\s+us\\b`,
].map((src) => new RegExp(src, "i"));

/** A year-shaped number is a headcount only where a count is expected. */
const COUNT_FRAME =
  /(?:\b(?:have|has|employs?|of|is|are|approximately|about|roughly|nearly|over|than|total(?:ing|s)?)\s+|[:=]\s*)$/i;

/**
 * Sentences that are plainly about the responding vendor. Narrower than
 * VENDOR_CUE: "we have 200 employees and 30 contractors" must still count.
 */
const VENDOR_STRONG =
  /\b(vendors?|bidders?|proposers?|respondents?|offerors?|firms|(?:selected|successful|winning|qualified|responding)\s+(?:firm|company)|service\s+providers?|MSPs?|your|key\s+personnel|proposed)\b/i;

function looseValue(tok: string): number {
  return Number(tok.replace(/,/g, ""));
}

/**
 * True when the text shows a population above `minimumUsers` anywhere: a
 * digit count against any people noun, a year-shaped, over-10,000 or
 * grouped number against one, "1.2k", or a number word of scale beside one.
 * Pure; a page can compute it server-side over the whole document and pass
 * the boolean down. `minimumUsers` defaults to 15 only so the one-argument
 * call works; pass the rate card's minimum.
 */
export function staffConflictSignals(
  docText: string,
  minimumUsers = 15
): boolean {
  if (typeof docText !== "string" || !docText) return false;
  const text = docText
    .replace(FORMAT_CHARS, "")
    .replace(/(\d),[\r\n]\s*(?=\d{3}(\D|$))/g, "$1,");
  for (const line of joinLines(text)) {
    for (const part of line.split(SENTENCE_SPLIT)) {
      const s = scanText(part);
      if (!s || !/\d|hundred|thousand|dozen|ty\b|ty-/i.test(s)) continue;
      if (VENDOR_STRONG.test(s)) continue;
      if (signalsOf(s).some((sig) => sig.hi > minimumUsers)) return true;
      if (P_CONFLICT_GROUPED.test(s) || P_CONFLICT_K.test(s)) return true;
      if (P_SCALE.some((re) => re.test(s))) return true;
      for (const re of [P_CONFLICT_NUM, P_CONFLICT_NOUN, P_CONFLICT_OF_US]) {
        re.lastIndex = 0;
        for (let m = re.exec(s); m; m = re.exec(s)) {
          const tok = m[1];
          if (looseValue(tok) <= minimumUsers) continue;
          // "Since 2019 staff has grown" is a date; "We have 2000 employees"
          // and "Staff: 2010" are counts.
          if (
            re === P_CONFLICT_NUM &&
            /^(?:19|20)\d\d$/.test(tok) &&
            !COUNT_FRAME.test(s.slice(0, m.index))
          )
            continue;
          re.lastIndex = 0;
          return true;
        }
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Whole-organization test: is this bound a claim about the client's own
// whole organization? "Up to 10 users per site", "fewer than 10 employees
// work remotely", "firms with fewer than 10 employees" and "we expect to add
// up to 10 employees" all bound something else. An ALLOWLIST of frames (the
// bound must be governed by one) plus vetoes; anything else asks.
// ---------------------------------------------------------------------------

/** A sentence shape that makes any bound in it a subset, a capacity, a
 *  vendor requirement, a negation or a question. Tested with the bound's own
 *  words ("not more than") removed. */
const SUBSET_SENTENCE =
  /\bper\b|\beach\b|\bevery\b|\bof\s+whom\b|\bof\s+our\b|\bout\s+of\b|\bat\s+a\s+time\b|\bat\s+once\b|\bseats?\b|\badd(?:s|ed|ing)?\b|\bgrow(?:th|s|ing|n)?\b|\bhir(?:e|es|ed|ing)\b|\bexpect|n[’']t\b|\bnot\b|\bnever\b|\bno\s+fewer\b|\?\s*$|\b(?:firms?|compan(?:y|ies)|organi[sz]ations?|vendors?|providers?|businesses)\s+with\b|\bmust\s+assign\b|\bmay\s+hold\b|\bwill\s+require\b/i;

/** A qualifier or noun inside the match that names a part of the staff. */
const SUBSET_SPAN =
  /\b(?:(?:full|part)[- ]time(?:rs)?|remote|on-?site|in-office|administrative|clinical|contracted|contract|seasonal|temporary|technical|support|licensed|concurrent|named|additional|seats?)\b/i;

/** What follows the noun and narrows it: "employees in IT", "staff who…". */
const SUBSET_AFTER =
  /^\s+(?:in\s+(?:it|hr|the|our|each|every|finance|accounting|admin)\b|on\s+(?:the|our|site|any|each)\b|at\s+(?:the|our|each|headquarters|hq)\b|who\b|that\b|work(?:s|ing)?\b|need(?:s|ing)?\b|use(?:s)?\b|using\b|share(?:s)?\b|are\b|were\b|will\b|may\b|can\b|should\b)/i;

/** The subject of "has"/"have" when it is a part, not the organization. */
const SUBSET_SUBJECT =
  /\b(?:departments?|depts?|divisions?|branch(?:es)?|offices?|sites?|locations?|units?|committees?|boards?|rooms?|floors?|campus(?:es)?|stores?|facilit(?:y|ies)|programs?|groups?|teams?|class(?:es)?|shifts?|warehouses?|headquarters|hq|desks?)\b/i;

const FRAME_TEAM =
  /\b(?:a|an|our|the|its)\s+(?:(?:small|lean|tiny|modest|total|current|combined|full|entire|whole)\s+)*(?:team|staff|workforce|headcount)\s+of\s+$/i;
const FRAME_VERB =
  /\b(?:have|has|employs?)\s+(?:(?:only|just|currently|a\s+total\s+of)\s+)?$/i;
const FRAME_COUNT =
  /\b(?:headcount|(?:staff|employee|user)\s+count|number\s+of\s+(?:staff|employees|users|people|FTEs))\s+(?:is|are|was|totals?|stands\s+at)\s+$/i;
/** A bare label: "Current Staff:", "Number of employees:", "Staff". */
const FRAME_LABEL =
  /^[#\s]*(?:(?:current|total|approximate|number\s+of|no\.\s+of|active|supported)\s+)*(?:staff|employees|users|headcount|FTEs?|personnel|people|workforce)(?:\s+(?:size|count|total))?\s*[:=]?\s*$/i;
const APPROX_TAIL =
  /(?:approximately|approx\.?|about|around|roughly|nearly|some|just)\s+$/i;

function wholeOrgBound(quote: string, sig: Signal): boolean {
  const s = scanText(quote);
  const stripped = s.replace(/\bnot\s+more\s+than\b/gi, " ");
  if (SUBSET_SENTENCE.test(stripped)) return false;
  if (SUBSET_SPAN.test(sig.span)) return false;
  const before = s.slice(0, sig.at).replace(APPROX_TAIL, "");
  // "a small team of", "Current Staff:" and "the number of employees is"
  // name the whole population outright; what follows the noun cannot narrow
  // it ("Our staff of up to 12 people works from one office").
  if (
    FRAME_TEAM.test(before) ||
    FRAME_COUNT.test(before) ||
    FRAME_LABEL.test(before)
  )
    return true;
  const verb = FRAME_VERB.exec(before);
  if (!verb) return false;
  // "We have fewer than 10 employees in IT": the tail narrows a plain verb.
  if (SUBSET_AFTER.test(s.slice(sig.end))) return false;
  // The subject: the clause in front of the verb.
  const subject = before.slice(0, verb.index).split(/[,;:]/).pop() ?? "";
  return !SUBSET_SUBJECT.test(subject);
}

/**
 * When the document's own staff evidence says the client fits inside the
 * monthly minimum, "up to `minimumUsers` users at the minimum fee" is the
 * likely answer. Returns the evidence quote, else null.
 *
 * This NEVER prices anything by itself (the generate route seeds only an
 * exact grounded count). It decides which answer the workspace offers as the
 * primary one-tap button, and which evidence it shows beside it.
 *
 * - statedStaff count <= minimumUsers           -> statedStaff.quote
 * - statedStaff range with hi <= minimumUsers   -> statedStaff.quote, unless
 *   a mention (or docText) shows a larger population: "Our main office has
 *   10-12 employees" beside "We support 85 users across three sites" asks.
 * - statedStaff null: some mention CAPS the client's WHOLE organization at
 *   or under the minimum (an upper-bound phrase or an explicit range, in an
 *   own-organization frame: "we have", "a small team of", "Current Staff:"),
 *   AND nothing shows a larger population. A subset, a capacity, a vendor
 *   requirement, a negation, a question or a conflict returns null: the
 *   workspace asks, with the evidence shown and no primary minimum button.
 *
 * A bare count in a mention ("12 employees") never triggers on its own: it
 * may be one office, one department or the part-time half, which is exactly
 * why the reader declined to report it.
 *
 * `docText` (optional) is the whole document, for the conflict scan the
 * mentions cannot carry: number words ("two hundred employees") and people
 * nouns outside the population list ("60 attorneys"). Without it the scan
 * runs over the mention quotes only. A caller that cannot ship the document
 * to where this runs computes staffConflictSignals() where it can and skips
 * the call when that is true.
 */
export function minimumAssumption(
  statedStaff: StatedStaff | null,
  mentions: StaffMention[],
  minimumUsers: number,
  docText?: string
): { quote: string } | null {
  if (!Number.isFinite(minimumUsers) || minimumUsers < 1) return null;
  if (statedStaff && statedStaff.count !== null)
    return statedStaff.count <= minimumUsers
      ? { quote: statedStaff.quote }
      : null;

  let evidence: string | null = null;
  for (const m of mentions) {
    if (!m || typeof m.quote !== "string") continue;
    for (const sig of signalsOf(m.quote)) {
      if (sig.hi > minimumUsers) return null;
      if (sig.upper && evidence === null && wholeOrgBound(m.quote, sig))
        evidence = m.quote;
    }
    if (staffConflictSignals(m.quote, minimumUsers)) return null;
  }
  if (docText !== undefined && staffConflictSignals(docText, minimumUsers))
    return null;

  if (statedStaff) {
    const range = parseStaffRange(statedStaff.quote);
    return range && range.hi <= minimumUsers
      ? { quote: statedStaff.quote }
      : null;
  }
  return evidence === null ? null : { quote: evidence };
}
