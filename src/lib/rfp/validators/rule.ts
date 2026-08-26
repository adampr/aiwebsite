/**
 * The validator contract.
 *
 * Every rule in DOMAIN-RULES.md gets one validator emitting its own stable ruleId. The
 * correspondence between the documentation and the code is enforced mechanically by a meta-test,
 * because it will otherwise decay within a month.
 *
 * Validators run against the CONTENT MODEL, never against rendered output. A rule that runs on the
 * PDF has to be re-implemented for the .docx, and then the two implementations disagree, which is
 * the exact class of bug this architecture exists to prevent.
 */

import { resolvedTextSpans } from "@/lib/rfp/content-model";
import type {
  BlockMeasurement,
  Fact,
  KnowledgeSnapshot,
  RateCard,
  Requirement,
  RequirementCoverage,
  ResolvedProposal,
  Severity,
  Violation,
} from "@/lib/rfp/content-model";

/** Everything a validator is allowed to see. Notably: no rendered output, and no database. */
export type ValidationContext = {
  proposal: ResolvedProposal;
  /** The CURRENT knowledge base, which may be newer than the one the proposal was drafted against. */
  knowledge: KnowledgeSnapshot;
  rateCard: RateCard;
  requirements: Requirement[];
  coverage: RequirementCoverage[];
  /** Facts resolved by id, including retired ones, so C1 can see a superseded citation. */
  factsById: Record<string, Fact>;
  /** True when the RFP states a staff count rather than a supported-user count (rule B4). */
  statesHeadcountOnly: boolean;
  supportedUserSplitConfirmed: boolean;
  /**
   * Block heights from the render service's measurer, when one has run.
   *
   * Rule D5 needs a browser to measure, which a validator may not have. The measurement is
   * supplied here rather than taken, so the validator stays a pure function of its context and
   * never reaches for rendered output itself.
   */
  measurements?: BlockMeasurement[];
};

export type Rule = {
  /** "A1", "B2" — stable, matching DOMAIN-RULES.md exactly. */
  id: string;
  /** The rule's one-line title, as the docs state it. */
  title: string;
  severity: Severity;
  check: (ctx: ValidationContext) => Violation[];
};

export function violation(input: {
  ruleId: string;
  severity: Severity;
  message: string;
  /**
   * Set this INSTEAD of hand-formatting an instant into `message` (§5.17, the
   * viewer-zone timestamp class). A rule that names a stored timestamp builds the
   * split form and derives `message` from it with `flattenTimedMessage`, so the flat
   * fallback and the rendered sentence can never disagree. C1 is the only rule that
   * needs it today; a bare `toISOString().slice(0, 10)` in a message is the defect.
   */
  timedMessage?: Violation["timedMessage"];
  locator?: Violation["locator"];
  excerpt?: string;
  suggestion?: string;
}): Violation {
  return {
    ruleId: input.ruleId,
    severity: input.severity,
    message: input.message,
    // Omitted rather than set to undefined: a GateResult is JSON.stringify'd into
    // rfp_proposals.gate_json, and an explicit undefined would serialise the key
    // away anyway, so the absent-key shape is the one that round-trips.
    ...(input.timedMessage ? { timedMessage: input.timedMessage } : {}),
    locator: input.locator ?? {},
    ...(input.excerpt ? { excerpt: input.excerpt } : {}),
    ...(input.suggestion ? { suggestion: input.suggestion }: {}),
    overriddenBy: null,
    overrideReason: null,
  };
}

/**
 * Scan every client-facing string in the document for a set of forbidden phrases.
 *
 * This is the workhorse behind the A-series rules, and it deliberately scans
 * `resolvedTextSpans`, which includes the cover, the letter, and the back cover as well as every
 * block. When "month-to-month" was corrected it was found in SIX places in one document: the terms
 * table, a reference blurb, a PULL QUOTE, the differentiator answer, and two body paragraphs. A
 * scanner that only looked at prose blocks would have found one of them.
 */
export function scanForbiddenPhrases(
  ctx: ValidationContext,
  options: {
    ruleId: string;
    severity: Severity;
    phrases: string[];
    message: (phrase: string) => string;
    suggestion?: string;
  },
): Violation[] {
  const violations: Violation[] = [];
  const spans = textSpans(ctx);

  for (const span of spans) {
    const haystack = span.text.toLowerCase();
    for (const phrase of options.phrases) {
      const needle = phrase.toLowerCase();
      const index = haystack.indexOf(needle);
      if (index === -1) continue;

      violations.push(
        violation({
          ruleId: options.ruleId,
          severity: options.severity,
          message: options.message(phrase),
          locator: {
            ...(span.sectionId ? { sectionId: span.sectionId } : {}),
            ...(span.blockId ? { blockId: span.blockId } : {}),
            field: span.field,
            charOffset: index,
          },
          excerpt: excerptAround(span.text, index, phrase.length),
          ...(options.suggestion ? { suggestion: options.suggestion } : {}),
        }),
      );
    }
  }

  return violations;
}

/**
 * Cached per-context, since most rules scan the same spans and the A-series alone walks them
 * eight times.
 */
const spanCache = new WeakMap<ValidationContext, ReturnType<typeof resolvedTextSpans>>();

export function textSpans(ctx: ValidationContext): ReturnType<typeof resolvedTextSpans> {
  let spans = spanCache.get(ctx);
  if (!spans) {
    spans = resolvedTextSpans(ctx.proposal);
    spanCache.set(ctx, spans);
  }
  return spans;
}

export function excerptAround(text: string, index: number, length: number, pad = 42): string {
  const start = Math.max(0, index - pad);
  const end = Math.min(text.length, index + length + pad);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

/** Whole-document text, for rules that ask "does this appear anywhere at all?" */
export function documentText(ctx: ValidationContext): string {
  return textSpans(ctx)
    .map((s) => s.text)
    .join("\n");
}

export function mentions(ctx: ValidationContext, phrases: string[]): boolean {
  const text = documentText(ctx).toLowerCase();
  return phrases.some((p) => text.includes(p.toLowerCase()));
}
