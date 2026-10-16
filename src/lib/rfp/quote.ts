// The pricing-quote builder (ARCHITECTURE.md §5.17.1).
//
// Humans enter QUANTITIES here; every dollar figure is computed by
// content-model/pricing from the rate card in force. This module is the ONLY
// place a PricingQuote is constructed at runtime, which is what makes rule
// B7's sanctioned set ("figures the pricing engine produced") a real
// boundary rather than a convention. Notes are engine-authored strings: the
// figures inside them are computed here from integer cents, never typed.
//
// One-time and per-session items (onboarding, Datto setup, vulnerability
// scanning) deliberately do NOT appear as illustration lines: an
// illustration's monthlyTotal sums every line, and a one-time fee inside it
// would state a wrong month. They land in `notes`, computed.

import {
  buildIllustration,
  makeLine,
  applyMinimum,
  computeMonthlyTotal,
  formatMoney,
  usd,
  FULLY_MANAGED_USER_CODE,
  type Money,
  type PricingIllustration,
  type PricingLine,
  type PricingQuote,
  type RateCard,
} from "@/lib/rfp/content-model";
import { onboardingFee } from "@/lib/rfp/seed/rate-card";
import type { RateCardView } from "@/lib/rfp/db";

/**
 * What the human answers. Everything optional so the workspace can ask one
 * question at a time and rebuild after every answer; the quote renders once
 * `fullyManagedUsers` exists and grows as the rest arrive.
 */
export type QuoteInputs = {
  /**
   * The supported POPULATION (or the RFP's stated headcount when
   * statesHeadcountOnly). The fully-managed line prices this count MINUS any
   * M365-only population below — m365OnlyUsers is "of those", never an
   * additional group, and every basis sentence states both counts so the
   * reading survives into the document.
   */
  fullyManagedUsers: number | null;
  /**
   * True when the RFP states total staff rather than supported users
   * (rule B4). Forces a second illustration.
   */
  statesHeadcountOnly: boolean;
  /** Confirmed split from the client (clears B4's demand for two views). */
  supportedUserSplitConfirmed: boolean;
  /** Estimated M365-only population for the split illustration. */
  m365OnlyUsers: number | null;
  /** Computers under XL Secure+. 0 = not offered in this quote. */
  securePlusComputers: number | null;
  /** Datto SaaS Protection retention tier. "both" totals the 1-year tier and notes the other. */
  dattoRetention: "1yr" | "infinite" | "both" | "none" | null;
  /** Users covered by Datto. Defaults to fullyManagedUsers when null. */
  dattoUsers: number | null;
  /** Vulnerability-scan sessions per year. 0 = not offered. */
  vulnScanSessionsPerYear: number | null;
  /** Onboarding: one month of BASE managed service, one time. */
  includeOnboarding: boolean | null;
};

export const EMPTY_QUOTE_INPUTS: QuoteInputs = {
  fullyManagedUsers: null,
  statesHeadcountOnly: false,
  supportedUserSplitConfirmed: false,
  m365OnlyUsers: null,
  securePlusComputers: null,
  dattoRetention: null,
  dattoUsers: null,
  vulnScanSessionsPerYear: null,
  includeOnboarding: null,
};

const int = (v: unknown, max: number): number | null => {
  // null/undefined/"" mean UNANSWERED and must round-trip as null.
  // Number(null) is 0, and a coerced 0 here silently turns "not asked yet"
  // into "answered zero", dropping services from the client-facing quote.
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(Math.floor(n), max);
};

/**
 * Where the fully-managed count came from. Lives INSIDE pricing_inputs_json
 * but deliberately OUTSIDE QuoteInputs: parseQuoteInputs() can never yield
 * it, so a request body cannot smuggle provenance — the pricing route
 * re-derives it (stored value unchanged keeps the stored source; any change
 * flips it to "staff"). null = legacy/manual, rendered as staff-entered.
 * Never read by buildQuote or any dollar math.
 */
export type FmuSource = "rfp" | "staff" | null;

export function parseInputsSource(raw: unknown): FmuSource {
  const v =
    raw && typeof raw === "object"
      ? (raw as Record<string, unknown>).fullyManagedUsersSource
      : null;
  return v === "rfp" || v === "staff" ? v : null;
}

/** Parse untrusted request/stored JSON into well-formed inputs. */
export function parseQuoteInputs(raw: unknown): QuoteInputs {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const retention = ["1yr", "infinite", "both", "none"].includes(String(o.dattoRetention))
    ? (String(o.dattoRetention) as QuoteInputs["dattoRetention"])
    : null;
  return {
    fullyManagedUsers: int(o.fullyManagedUsers, 100_000),
    statesHeadcountOnly: o.statesHeadcountOnly === true,
    supportedUserSplitConfirmed: o.supportedUserSplitConfirmed === true,
    m365OnlyUsers: int(o.m365OnlyUsers, 100_000),
    securePlusComputers: int(o.securePlusComputers, 100_000),
    dattoRetention: retention,
    dattoUsers: int(o.dattoUsers, 100_000),
    vulnScanSessionsPerYear: int(o.vulnScanSessionsPerYear, 52),
    includeOnboarding:
      o.includeOnboarding === true ? true : o.includeOnboarding === false ? false : null,
  };
}

/** DB rate-card view (integer cents) to the content-model shape (Money). */
export function toRateCard(view: RateCardView): RateCard {
  return {
    id: view.id,
    effectiveFrom: view.effectiveFrom,
    effectiveTo: null,
    minimumFullyManagedUsers: view.minimumFullyManagedUsers,
    minimumMonthlyFee: usd(view.minimumMonthlyFeeCents),
    items: view.items.map((i) => ({
      code: i.code,
      label: i.label,
      unitPrice: usd(i.unitPriceCents),
      unit: i.unit,
      note: i.note,
    })),
  };
}

function item(card: RateCard, code: string) {
  const found = card.items.find((i) => i.code === code);
  if (!found) throw new Error(`rate card has no item "${code}"`);
  return found;
}

function monthlyLines(
  card: RateCard,
  idPrefix: string,
  q: {
    fullyManagedUsers: number;
    m365OnlyUsers: number;
    securePlusComputers: number;
    dattoTier: "1yr" | "infinite" | null;
    dattoUsers: number;
  }
): PricingLine[] {
  const lines: PricingLine[] = [];
  const push = (code: string, quantity: number, labelSuffix = "") => {
    if (quantity <= 0) return;
    const it = item(card, code);
    lines.push(
      makeLine({
        id: `${idPrefix}_${code}`,
        rateCardItemCode: code,
        label: it.label + labelSuffix,
        quantity,
        unitPrice: it.unitPrice,
      })
    );
  };
  push(FULLY_MANAGED_USER_CODE, q.fullyManagedUsers);
  push("m365-only-user", q.m365OnlyUsers);
  push("xl-secure-plus", q.securePlusComputers);
  if (q.dattoTier)
    push(q.dattoTier === "1yr" ? "datto-retention-1yr" : "datto-retention-infinite", q.dattoUsers);
  return lines;
}

/**
 * The floored BASE managed monthly (fully-managed line only), which is what
 * onboarding equals. Intake question 8 re-confirms this every time because
 * getting it wrong at a 200-user prospect is a five-figure error.
 */
function baseManagedMonthly(card: RateCard, fullyManagedUsers: number): Money {
  if (fullyManagedUsers <= 0) return usd(0);
  const base = [
    makeLine({
      id: "base_managed",
      rateCardItemCode: FULLY_MANAGED_USER_CODE,
      label: "base",
      quantity: fullyManagedUsers,
      unitPrice: item(card, FULLY_MANAGED_USER_CODE).unitPrice,
    }),
  ];
  const { lines } = applyMinimum(base, card);
  return computeMonthlyTotal(lines);
}

/**
 * True when a fully managed count is billed as the rate card's minimum block:
 * below the minimum when the flat floor really applies (the same two tests
 * as applyMinimum: under the count AND under the fee, so a card whose
 * per-user product already reaches the fee bills the plain product), and AT
 * the minimum, where the line is that block of users anyway. A minimum of
 * one user is no block at all.
 */
function atMinimum(card: RateCard, managed: number): boolean {
  const min = card.minimumFullyManagedUsers;
  if (managed <= 0 || min <= 1) return false;
  if (managed === min) return true;
  if (managed > min) return false;
  const unit = item(card, FULLY_MANAGED_USER_CODE).unitPrice;
  return unit.cents * managed < card.minimumMonthlyFee.cents;
}

const managedUsers = (n: number): string =>
  `${n} fully managed user${n === 1 ? "" : "s"}`;

/**
 * The fully managed clause of a basis sentence. Owner ruling 2026-09-30: at
 * or under the minimum the answer is always "up to N users at the monthly
 * minimum" (N from the card, never typed), not a count that does not
 * multiply to the line. The typed count is dropped in that reading: the
 * engine cannot tell an RFP-stated number from a staff entry, so "N stated"
 * would be a claim it cannot back. With a Microsoft 365-only tier the real
 * count STAYS, because that sentence has to add up to the population it
 * splits; the minimum rides in a parenthesis instead. No dollar figure
 * here: rule B7 sanctions figures from lines, totals and notes only.
 */
function managedPhrase(card: RateCard, managed: number, withSplit: boolean): string {
  const min = card.minimumFullyManagedUsers;
  if (!atMinimum(card, managed)) return managedUsers(managed);
  if (!withSplit) return `Up to ${min} fully managed users at the monthly minimum`;
  return managed < min
    ? `${managedUsers(managed)} (billed as up to ${min} at the monthly minimum)`
    : managedUsers(managed);
}

/** The one sentence explaining the monthly minimum, printed after the
 *  illustrations by BOTH the Word/PDF emitters and the workspace's
 *  Investment sheet whenever any illustration applied the minimum. One
 *  author so the screen shows exactly what the file prints (the screen used
 *  to omit it). Client-safe: formatMoney is pure. */
export function minimumSentence(
  minimumUsers: number,
  minimumMonthlyCents: number
): string {
  return `Where fewer than ${minimumUsers} users are fully managed, the fully managed line is billed at the monthly minimum of ${formatMoney(usd(minimumMonthlyCents), { cents: "always" })} rather than the per-user product.`;
}

/** Display text for a line's quantity cell: "Up to 15" for the fully managed line when that is what was billed (the illustration's monthly minimum applied, or the count equals a minimum above one), else String(line.quantity). */
export function quantityLabel(
  line: PricingLine,
  ill: PricingIllustration,
  minimumUsers: number
): string {
  // Pure and display-only: the stored quantity stays the real count, which
  // is what rule B5's recompute and the onboarding note read. Works on
  // quotes stored before this helper existed (it reads nothing new).
  //
  // True to what was billed: `minimumApplied` is the engine's own record
  // that the flat floor replaced the per-user product. A count under the
  // minimum whose product was billed as-is (a card whose floor is lower
  // than count x unit) prints the count, and so does a stored quote whose
  // count exceeds a minimum that has since changed.
  if (line.rateCardItemCode !== FULLY_MANAGED_USER_CODE) return String(line.quantity);
  const billedAsBlock =
    (ill.minimumApplied && line.quantity <= minimumUsers) ||
    (minimumUsers > 1 && line.quantity === minimumUsers);
  return billedAsBlock ? `Up to ${minimumUsers}` : String(line.quantity);
}

/* ------------------------------------------------------------------------ */
/* The cover letter's system pricing paragraph (§5.17.20)                   */
/* ------------------------------------------------------------------------ */

// The engine's own note templates below (buildQuote), read back for their
// COMPUTED one-time figures. Same file, same author: test:rfpquote pins that
// every note buildQuote can write parses here, so a template edit that broke
// the read would fail the suite, not silently drop a fee from the letter.
const MONEY_RE = String.raw`\$(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{2}))?`;
const ONBOARDING_ONE_RE = new RegExp(`^Onboarding is a one-time fee of ${MONEY_RE},`);
const ONBOARDING_EACH_RE = new RegExp(`${MONEY_RE} under "([^"]*)"`, "g");
const DATTO_SETUP_RE = new RegExp(`^Datto SaaS Protection carries a one-time setup fee of ${MONEY_RE}\\.`);
const VULN_SCAN_RE = /^Vulnerability scanning and review: /;

const centsOf = (dollars: string, cents: string | undefined): number =>
  Number(dollars.replace(/,/g, "")) * 100 + (cents ? Number(cents) : 0);

/** The letter is prose: a whole-dollar figure prints without ".00" ("$247",
 *  "$14,820"), cents only when there are some ("$3.20"). Exactly the same
 *  amounts the Investment sheet prints with cents:"always" (round 11), so
 *  rule B1 reads the same money either way. */
const fmt = (cents: number): string => formatMoney(usd(cents), { cents: "auto" });

const lowerFirst = (s: string): string =>
  /^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;

/** "A, B and C"; "A; B; and C" when any item has a comma of its own (a
 *  label like "Datto SaaS Protection, one-year retention"), so a reader can
 *  still count the items. */
const andList = (xs: string[]): string => {
  if (xs.length <= 1) return xs[0] ?? "";
  const head = xs.slice(0, -1);
  const last = xs[xs.length - 1];
  return xs.some((x) => x.includes(","))
    ? `${head.join("; ")}; and ${last}`
    : `${head.join(", ")} and ${last}`;
};

/** "60 fully managed users at $247 per user per month", or the block
 *  reading at the minimum ("up to 15 fully managed users at the monthly
 *  minimum"), decided by quantityLabel exactly as the Investment table's
 *  quantity cell is. */
function managedLead(
  line: PricingLine,
  ill: PricingIllustration,
  minimumUsers: number | null
): string {
  const label = minimumUsers !== null ? quantityLabel(line, ill, minimumUsers) : String(line.quantity);
  if (label.startsWith("Up to "))
    return `up to ${label.slice(6)} fully managed users at the monthly minimum`;
  return `${managedUsers(line.quantity)} at ${fmt(line.unitPrice.cents)} per user per month`;
}

/**
 * The ONE paragraph of pricing the cover letter carries, composed by the
 * system from the stored quote, never by the model (rule 3: the letter turn
 * never writes a price, rate or term). Every figure in it is a figure the
 * Investment sheet prints from the same PricingQuote: a line's unit price,
 * an illustration's monthly total, a line total at the minimum, and the
 * one-time fees the engine's own notes state, whole dollars without ".00"
 * (prose; the Investment table keeps cents:"always"). It
 * names an included (zero-priced) line as included, and states NO contract
 * term: the quote carries none, and a term is never inferred.
 *
 * Null when there is nothing to state (no quote, no illustration): the
 * letter then reads exactly as before. Pure and client-safe; the workspace
 * calls it with the same stored quote and minimum it renders the Investment
 * sheet from, resolve-draft with the quote and rate card the export uses.
 */
export function letterPricingParagraph(
  quote: PricingQuote | null,
  minimumUsers: number | null
): string | null {
  if (!quote || quote.illustrations.length === 0) return null;
  const parts: string[] = [];
  const isManaged = (l: PricingLine) => l.rateCardItemCode === FULLY_MANAGED_USER_CODE;

  if (quote.illustrations.length === 1) {
    const ill = quote.illustrations[0];
    const managed = ill.lines.find(isManaged) ?? null;
    const paid = ill.lines.filter((l) => !isManaged(l) && l.lineTotal.cents > 0);
    const included = ill.lines.filter((l) => !isManaged(l) && l.lineTotal.cents === 0 && l.quantity > 0);
    const total = fmt(ill.monthlyTotal.cents);
    if (managed) {
      parts.push(`The pricing is straightforward: ${managedLead(managed, ill, minimumUsers)}, ${total} per month in total.`);
      if (paid.length)
        parts.push(`That total also covers ${andList(paid.map((l) => l.label))}, each itemized on the Investment page.`);
    } else {
      parts.push(
        paid.length
          ? `The pricing is straightforward: ${total} per month in total, covering ${andList(paid.map((l) => l.label))}, each itemized on the Investment page.`
          : `The pricing is straightforward: ${total} per month in total.`
      );
    }
    for (const l of included) parts.push(`${l.label} is included in the monthly fee.`);
  } else {
    // Rule B4's two views: the letter states both and anchors on neither.
    const views = quote.illustrations.map(
      (ill) => `${lowerFirst(ill.label)}, ${fmt(ill.monthlyTotal.cents)} per month`
    );
    parts.push(
      `The Investment page prices this ${quote.illustrations.length === 2 ? "two" : "several"} ways, because the real split of users is a discovery task: ${views.join("; or ")}.`
    );
    const unit = quote.illustrations.flatMap((ill) => ill.lines.filter(isManaged))[0]?.unitPrice
      .cents;
    if (unit) parts.push(`Each fully managed user is ${fmt(unit)} per user per month in XL.net fees.`);
  }

  for (const note of quote.notes) {
    const one = ONBOARDING_ONE_RE.exec(note);
    if (one) {
      parts.push(`Onboarding is a one-time fee of ${fmt(centsOf(one[1], one[2]))}.`);
      continue;
    }
    if (note.startsWith("Onboarding is a one-time fee equal to")) {
      const each = [...note.matchAll(ONBOARDING_EACH_RE)].map(
        (m) => `${fmt(centsOf(m[1], m[2]))} under "${m[3]}"`
      );
      if (each.length) parts.push(`Onboarding is a one-time fee: ${andList(each)}.`);
      continue;
    }
    const datto = DATTO_SETUP_RE.exec(note);
    if (datto) {
      parts.push(`Datto SaaS Protection setup is a one-time fee of ${fmt(centsOf(datto[1], datto[2]))}.`);
      continue;
    }
    if (VULN_SCAN_RE.test(note))
      parts.push("Vulnerability scanning and review is billed per session, as the Investment page sets out.");
  }
  return parts.join(" ");
}

/**
 * The pricing part's dek on a brief (§5.17.21): ONE short sentence under the
 * part-4 divider title, composed by the system from the stored quote, never
 * by the model, in letterPricingParagraph's family (same inputs, the same
 * figures the Investment sheet prints, whole dollars in prose with cents
 * only when there are some, and NO contract term: the quote carries none).
 *   one illustration with a managed line:
 *     "60 fully managed users at $247 per user per month, $14,820 per month
 *      in total, itemized on the Investment page."
 *     (at the minimum: "Up to 15 fully managed users at the monthly
 *      minimum, $X per month in total, itemized on the Investment page.")
 *   one illustration without one:
 *     "$X per month in total, every line itemized on the Investment page."
 *   two or more (rule B4's views, anchored on neither):
 *     "Priced two ways, $A or $B per month, until the real split of users
 *      is confirmed."
 * Null when there is nothing to state (no quote, no illustration): the part
 * then falls back to its stored dek. Pure and client-safe; resolve-draft and
 * the workspace call it with the quote and minimum they hand
 * letterPricingParagraph.
 */
export function partPricingDek(
  quote: PricingQuote | null,
  minimumUsers: number | null
): string | null {
  if (!quote || quote.illustrations.length === 0) return null;
  const isManaged = (l: PricingLine) => l.rateCardItemCode === FULLY_MANAGED_USER_CODE;
  if (quote.illustrations.length === 1) {
    const ill = quote.illustrations[0];
    const managed = ill.lines.find(isManaged) ?? null;
    const total = fmt(ill.monthlyTotal.cents);
    if (managed) {
      const lead = managedLead(managed, ill, minimumUsers);
      return `${lead.charAt(0).toUpperCase()}${lead.slice(1)}, ${total} per month in total, itemized on the Investment page.`;
    }
    return `${total} per month in total, every line itemized on the Investment page.`;
  }
  const totals = quote.illustrations.map((ill) => fmt(ill.monthlyTotal.cents));
  const list =
    totals.length === 2 ? `${totals[0]} or ${totals[1]}` : `${totals.slice(0, -1).join(", ")} or ${totals[totals.length - 1]}`;
  return `Priced ${totals.length === 2 ? "two" : "several"} ways, ${list} per month, until the real split of users is confirmed.`;
}

export type BuiltQuote = {
  quote: PricingQuote;
  /** True when the quote is renderable (has at least one illustration). */
  ready: boolean;
  /** Inputs still needed before the quote is complete enough to send. */
  missing: string[];
};

/**
 * Deterministic quote from inputs + the rate card in force.
 *
 * Rule B4: when the RFP states headcount only and no split has been
 * confirmed, two illustrations are REQUIRED: one with every stated person
 * fully managed, one with the estimated split, labelled as an estimate. A
 * zero or missing estimate keeps the quote not-ready rather than building
 * the single-figure quote B4 exists to prevent; if truly everyone needs
 * full support, the split gets CONFIRMED, which clears B4 instead.
 *
 * Outside that scenario (supported-user counts known, or split confirmed),
 * a provided M365-only population is a real line in the one illustration —
 * a confirmed split the staff typed in must never silently vanish from the
 * client-facing quote.
 */
export function buildQuote(
  card: RateCard,
  inputs: QuoteInputs,
  proposalId: string
): BuiltQuote {
  const missing: string[] = [];
  if (inputs.fullyManagedUsers === null) missing.push("fullyManagedUsers");
  if (inputs.securePlusComputers === null) missing.push("securePlusComputers");
  if (inputs.dattoRetention === null) missing.push("dattoRetention");
  if (inputs.dattoRetention && inputs.dattoRetention !== "none" && inputs.dattoUsers === null)
    missing.push("dattoUsers");
  if (inputs.vulnScanSessionsPerYear === null) missing.push("vulnScanSessionsPerYear");
  if (inputs.includeOnboarding === null) missing.push("includeOnboarding");
  // A zero estimate is unresolved, not answered: B4 needs either a real
  // second illustration or a confirmed split.
  const needsSplit =
    inputs.statesHeadcountOnly &&
    !inputs.supportedUserSplitConfirmed &&
    !inputs.m365OnlyUsers;
  if (needsSplit) missing.push("m365OnlyUsers");

  const users = inputs.fullyManagedUsers ?? 0;
  // A typo like m365=50 of 20 people would print a self-contradictory basis
  // sentence; clamp to the population.
  const m365Known = Math.min(inputs.m365OnlyUsers ?? 0, users);
  const secure = inputs.securePlusComputers ?? 0;
  let dattoTier =
    inputs.dattoRetention === "1yr" || inputs.dattoRetention === "both"
      ? ("1yr" as const)
      : inputs.dattoRetention === "infinite"
        ? ("infinite" as const)
        : null;
  let dattoUsers = dattoTier ? (inputs.dattoUsers ?? users) : 0;
  // A tier with zero covered users is Datto NOT INCLUDED: without this, the
  // basis printed "Datto SaaS Protection for 0 users" while the notes
  // charged a $1,200 setup fee for a service the quote does not contain.
  if (dattoUsers <= 0) {
    dattoTier = null;
    dattoUsers = 0;
  }

  const headcountAmbiguous =
    inputs.statesHeadcountOnly && !inputs.supportedUserSplitConfirmed;

  const illustrations: PricingIllustration[] = [];
  if (users > 0) {
    // Primary illustration. Under headcount ambiguity every stated person is
    // priced fully managed (the ceiling view B4 pairs with the split view).
    // Otherwise the counts are the real ones, INCLUDING the M365-only line.
    const primaryM365 = headcountAmbiguous ? 0 : m365Known;
    const primaryManaged = headcountAmbiguous
      ? users
      : Math.max(users - primaryM365, 0);
    illustrations.push(
      buildIllustration({
        id: "ill_all_managed",
        label:
          primaryM365 > 0
            ? "Fully managed with a Microsoft 365-only tier"
            : "All supported users fully managed",
        basis: `${managedPhrase(card, primaryManaged, primaryM365 > 0)}${primaryM365 > 0 ? ` and ${primaryM365} users on Microsoft 365 support only` : ""}${secure > 0 ? `, ${secure} computers under XL Secure+` : ""}${dattoTier ? `, Datto SaaS Protection for ${dattoUsers} users` : ""}.`,
        lines: monthlyLines(card, "l1", {
          fullyManagedUsers: primaryManaged,
          m365OnlyUsers: primaryM365,
          securePlusComputers: secure,
          dattoTier,
          dattoUsers,
        }),
        rateCard: card,
      })
    );

    if (headcountAmbiguous && m365Known > 0) {
      const fullyManaged = Math.max(users - m365Known, 0);
      illustrations.push(
        buildIllustration({
          id: "ill_split",
          label: "Estimated split, to be confirmed in discovery",
          basis: `${managedPhrase(card, fullyManaged, true)} and ${m365Known} users on Microsoft 365 support only, out of the ${users} people the RFP states. The real split is a discovery task.`,
          lines: monthlyLines(card, "l2", {
            fullyManagedUsers: fullyManaged,
            m365OnlyUsers: m365Known,
            securePlusComputers: secure,
            dattoTier,
            dattoUsers: dattoTier ? Math.min(dattoUsers, fullyManaged + m365Known) : 0,
          }),
          rateCard: card,
        })
      );
    }
  }

  // Engine-authored notes. Every figure below is computed from integer cents.
  const notes: string[] = [];
  if (illustrations.length > 0 && inputs.includeOnboarding) {
    // Onboarding = one month of BASE managed service, computed PER
    // ILLUSTRATION from that illustration's fully-managed count. One figure
    // computed from the raw headcount would anchor the client on the largest
    // available number, which is what rule B4 exists to prevent, and getting
    // this wrong at scale is a five-figure error (rate card, onboarding note).
    const fees = illustrations.map((ill) => {
      const managed = ill.lines
        .filter((l) => l.rateCardItemCode === FULLY_MANAGED_USER_CODE)
        .reduce((n, l) => n + l.quantity, 0);
      return {
        label: ill.label,
        fee: usd(onboardingFee(baseManagedMonthly(card, managed).cents)),
      };
    });
    const allSame = fees.every((f) => f.fee.cents === fees[0].fee.cents);
    notes.push(
      allSame
        ? `Onboarding is a one-time fee of ${formatMoney(fees[0].fee)}, equal to one month of the base managed service (the fully managed user line with the ${card.minimumFullyManagedUsers}-user minimum applied). It does not include XL Secure+, Datto, or licensing.`
        : `Onboarding is a one-time fee equal to one month of the base managed service (the fully managed user line with the ${card.minimumFullyManagedUsers}-user minimum applied): ${fees.map((f) => `${formatMoney(f.fee)} under "${f.label}"`).join(", ")}. It does not include XL Secure+, Datto, or licensing.`
    );
  }
  if (dattoTier) {
    const setup = item(card, "datto-setup").unitPrice;
    notes.push(
      `Datto SaaS Protection carries a one-time setup fee of ${formatMoney(setup)}.`
    );
  }
  if (inputs.dattoRetention === "both") {
    const oneYr = item(card, "datto-retention-1yr").unitPrice;
    const infinite = item(card, "datto-retention-infinite").unitPrice;
    notes.push(
      `The illustrations above price the 1-year retention tier at ${formatMoney(oneYr)} per user per month. Infinite retention is available at ${formatMoney(infinite)} per user per month; the client picks the tier.`
    );
  }
  if ((inputs.vulnScanSessionsPerYear ?? 0) > 0) {
    const sessions = inputs.vulnScanSessionsPerYear!;
    const per = item(card, "vulnerability-scan").unitPrice;
    const annual = usd(per.cents * sessions);
    notes.push(
      `Vulnerability scanning and review: ${sessions} session${sessions === 1 ? "" : "s"} per year at ${formatMoney(per)} per session, ${formatMoney(annual)} per year. Internal and external, including the review-and-prioritize remediation meeting.`
    );
  }

  const quote: PricingQuote = {
    id: `quote_${proposalId}`,
    proposalId,
    rateCardId: card.id,
    illustrations,
    passThroughItems: [
      {
        label: "Microsoft 365 licensing",
        detail:
          "Billed at cost on a separate line. Never blended into the per-user XL.net fee.",
        billing: "at-cost",
      },
    ],
    notes,
  };

  // Not ready while B4's second view is unresolved: storing the single
  // headcount illustration would render a quote the gate then blocks.
  return { quote, ready: illustrations.length > 0 && !needsSplit, missing };
}
