/**
 * D. Style.
 */

import { TARGET_BLOCK_HEIGHT_PX, USABLE_CONTENT_HEIGHT_PX } from "@/lib/rfp/content-model";
import { hasMarkdownTable } from "@/lib/rfp/draft-blocks";
import { documentText, excerptAround, textSpans, violation, type Rule } from "./rule";

/**
 * D1 - Em dashes. BLOCK.
 *
 * Zero em dashes (U+2014) in any output format. En dashes in numeric ranges ("15-250") are fine.
 * This is not a style preference: it reads as machine-written to the people scoring these
 * documents. The blank template's own sample copy contains &mdash; entities, so this fires on a
 * fresh fill if the fill is careless.
 */
export const D1: Rule = {
  id: "D1",
  title: "Em dashes",
  severity: "block",
  check: (ctx) => {
    const violations = [];

    for (const span of textSpans(ctx)) {
      let index = span.text.indexOf("—");
      while (index !== -1) {
        violations.push(
          violation({
            ruleId: "D1",
            severity: "block",
            message: "Em dash (U+2014) in output. Replace with a period, comma, colon, or parentheses.",
            locator: {
              ...(span.sectionId ? { sectionId: span.sectionId } : {}),
              ...(span.blockId ? { blockId: span.blockId } : {}),
              field: span.field,
              charOffset: index,
            },
            excerpt: span.text.slice(Math.max(0, index - 40), index + 40),
          }),
        );
        index = span.text.indexOf("—", index + 1);
      }
    }

    return violations;
  },
};

/**
 * D2 - AI tells. WARN.
 *
 * Flag and suggest replacements. Prefer flat, matter-of-fact statements.
 */
const AI_TELLS: { phrase: string; instead: string }[] = [
  { phrase: "exactly the kind of", instead: "Name the thing directly." },
  { phrase: "mission-critical", instead: '"critical", or say which function it is critical to.' },
  { phrase: "seamless", instead: "Say what actually does not break." },
  { phrase: "robust", instead: "Give the number or the mechanism." },
  { phrase: "leverage", instead: '"use".' },
  { phrase: "built into how we work, not added on", instead: "Describe the mechanism instead." },
  { phrase: "in our backyard", instead: "Name the distance or the city." },
  { phrase: "underpinning", instead: '"supporting", or name the dependency.' },
  { phrase: "best-in-class", instead: "Name the product and why it was chosen." },
  { phrase: "cutting-edge", instead: "Say what it does." },
  { phrase: "world-class", instead: "Give the measure." },
];

export const D2: Rule = {
  id: "D2",
  title: "AI tells",
  severity: "warn",
  check: (ctx) => {
    const violations = [];

    for (const span of textSpans(ctx)) {
      const lower = span.text.toLowerCase();
      for (const tell of AI_TELLS) {
        let index = lower.indexOf(tell.phrase);
        while (index !== -1) {
          violations.push(
            violation({
              ruleId: "D2",
              severity: "warn",
              message: `"${tell.phrase}" reads as machine-written.`,
              locator: {
                ...(span.sectionId ? { sectionId: span.sectionId } : {}),
                ...(span.blockId ? { blockId: span.blockId } : {}),
                field: span.field,
                charOffset: index,
              },
              excerpt: span.text.slice(Math.max(0, index - 40), index + 50),
              suggestion: tell.instead,
            }),
          );
          index = lower.indexOf(tell.phrase, index + tell.phrase.length);
        }
      }

      // Stacked semicolons: more than two in one sentence reads as generated.
      const semicolons = (span.text.match(/;/g) ?? []).length;
      if (semicolons > 2) {
        violations.push(
          violation({
            ruleId: "D2",
            severity: "warn",
            message: `${semicolons} semicolons in one span reads as generated. Break it into sentences.`,
            locator: {
              ...(span.sectionId ? { sectionId: span.sectionId } : {}),
              ...(span.blockId ? { blockId: span.blockId } : {}),
              field: span.field,
            },
            excerpt: span.text.slice(0, 140),
          }),
        );
      }
    }

    return violations;
  },
};

/**
 * D3 - Reference etiquette. BLOCK when references appear.
 *
 * The proposal must state that references are called as a final step before contract, out of
 * respect for clients' time. And an unresolved bracketed placeholder must never reach a
 * deliverable.
 */
export const D3: Rule = {
  id: "D3",
  title: "Reference etiquette",
  severity: "block",
  check: (ctx) => {
    const violations = [];

    // Unresolved placeholders anywhere are a BLOCK, references or not.
    const placeholder = /\[(Contact|Phone|Name|Company|Email|Client|Title|Date|COMPANY NAME|TBD)[^\]]*\]/i;
    for (const span of textSpans(ctx)) {
      const match = placeholder.exec(span.text);
      if (!match) continue;
      violations.push(
        violation({
          ruleId: "D3",
          severity: "block",
          message: `Unresolved placeholder "${match[0]}" would ship to the client.`,
          locator: {
            ...(span.sectionId ? { sectionId: span.sectionId } : {}),
            ...(span.blockId ? { blockId: span.blockId } : {}),
            field: span.field,
            charOffset: match.index,
          },
          excerpt: span.text.slice(Math.max(0, match.index - 30), match.index + 50),
        }),
      );
    }

    const text = documentText(ctx);
    const hasReferences =
      ctx.proposal.references.length > 0 || /\breferences?\b/i.test(text);
    if (!hasReferences) return violations;

    const statesEtiquette =
      /final step before contract/i.test(text) ||
      (/respect for (our )?clients?[’']? time/i.test(text) && /reference/i.test(text));

    if (!statesEtiquette) {
      violations.push(
        violation({
          ruleId: "D3",
          severity: "block",
          message:
            "References appear but the proposal does not state that they are called as a final step before contract, out of respect for clients' time.",
          suggestion:
            "Out of respect for our clients' time, we ask that references be called as a final step before contract rather than earlier in the evaluation.",
        }),
      );
    }

    return violations;
  },
};

/**
 * The prospect's headcount as the proposal states it ("your 40 users"), or null. The high end of
 * a range is not a headcount: "15 to 250 employees" is XL.net's own client-size sentence (the
 * About fact grid and most Overview drafts carry it), and reading its 250 as the prospect made
 * every proposal without a quote warn about a 250-person client. Lookbehind is fine here: the
 * validators are server-only (the workspace imports only the GateResult type).
 */
export function prospectHeadcount(text: string): number | null {
  const m = /(?<!\d\s*to\s*)\b(\d{2,4})\s*(?:staff|employees|people|users)\b/i.exec(text);
  return m ? Number(m[1]) : null;
}

/**
 * D4 - Honest gap framing. WARN.
 *
 * Where XL.net does not fit, the required shape is: relevant strength, then the gap stated plainly,
 * then a forward commitment. Never bury, never spin.
 *
 * Fit gaps count too, not just capability gaps. A prospect at the edge of the stated 15-to-250
 * range should see that named in the cover letter rather than discovering it at reference check.
 */
export const D4: Rule = {
  id: "D4",
  title: "Honest gap framing",
  severity: "warn",
  check: (ctx) => {
    const violations = [];
    const text = documentText(ctx);

    // Any acknowledged gap should carry a forward commitment near it.
    const gapCoverage = ctx.coverage.filter((c) => c.state === "gap-acknowledged");
    for (const coverage of gapCoverage) {
      const section = ctx.proposal.sections.find((s) => s.id === coverage.sectionId);
      if (!section) continue;

      const sectionText = section.blocks
        .flatMap((b) => ("text" in b ? [b.text as string] : "body" in b ? [b.body as string] : []))
        .join(" ");

      const hasForwardCommitment =
        /we would|we will|we can|happy to discuss|discuss (this )?openly|at interview|would like to discuss/i.test(
          sectionText,
        );
      if (!hasForwardCommitment) {
        violations.push(
          violation({
            ruleId: "D4",
            severity: "warn",
            message: `Section ${section.structureLabel} acknowledges a gap but offers no forward commitment. The shape is: relevant strength, gap stated plainly, forward commitment.`,
            locator: { sectionId: section.id, requirementId: coverage.requirementId },
          }),
        );
      }
    }

    // A fit gap at the edge of the stated client-size range should be named, not left to discovery.
    const rangeFact = ctx.knowledge.facts.find((f) => f.key === "company.client-size-range");
    if (rangeFact) {
      const staff = prospectHeadcount(text);
      const atEdge = staff !== null && (staff <= 16 || staff >= 220);
      const namesTheEdge = /small end|large end|edge of|upper end|lower end|top of our range/i.test(text);
      if (atEdge && !namesTheEdge) {
        violations.push(
          violation({
            ruleId: "D4",
            severity: "warn",
            message: `The prospect is at about ${staff}, near the edge of the stated 15 to 250 client-size range, and the proposal does not name that. Surfacing it converts a silent scoring loss into a conversation.`,
            suggestion: rangeFact.statement,
          }),
        );
      }
    }

    return violations;
  },
};

/**
 * D5 - Page budget. WARN.
 *
 * Usable content height is 883px at the template's 0.9in margin. Measured empirically: an 878px
 * block fits, an 885px block splits. Target 860px so a later one-line correction does not cost a
 * page.
 *
 * The measurement itself needs a browser, so it is supplied to the context by the render service
 * rather than computed here. This validator reports what the measurer found.
 */
export const D5: Rule = {
  id: "D5",
  title: "Page budget",
  severity: "warn",
  check: (ctx) => {
    const measurements = ctx.proposal.sections.length > 0 ? ctx.measurements : undefined;
    if (!measurements || measurements.length === 0) return [];

    return measurements
      .filter((m) => m.status !== "ok")
      .map((m) =>
        violation({
          ruleId: "D5",
          severity: "warn",
          message:
            m.status === "over"
              ? `Block ${m.blockId} is ${m.heightPx}px, ${m.overByPx}px over the ${USABLE_CONTENT_HEIGHT_PX}px budget. It will split and waste most of a page.`
              : `Block ${m.blockId} is ${m.heightPx}px, over the ${TARGET_BLOCK_HEIGHT_PX}px target. A one-line correction later would cost a page.`,
          locator: { blockId: m.blockId },
          suggestion:
            "Tighten paragraph margins, tile padding, or grid margin-bottoms, or cut a sentence. Do not shrink fonts.",
        }),
      );
  },
};

/**
 * Where the first markdown table in `text` starts, as a char offset, found by asking THE detector
 * (hasMarkdownTable) about line prefixes rather than re-implementing it: a table needs its header,
 * separator and first data line on three consecutive lines, so the shortest prefix that holds a
 * table ends on the first table's first data line, and that table starts two lines above it. The
 * prefix answer is monotone (a longer prefix keeps every table a shorter one had), so a binary
 * search keeps a hostile thousand-line span at a handful of detector calls. The caller has already
 * established that the whole text holds a table.
 */
function firstTableOffset(text: string): number {
  const lines = text.split("\n");
  let lo = Math.min(3, lines.length);
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (hasMarkdownTable(lines.slice(0, mid).join("\n"))) hi = mid;
    else lo = mid + 1;
  }
  const start = Math.max(0, lo - 3);
  let offset = 0;
  for (let i = 0; i < start; i++) offset += lines[i].length + 1;
  return offset;
}

/**
 * D6 - Tabular text in prose. WARN.
 *
 * A GitHub-markdown table (pipe rows under a `|---|` separator) inside a paragraph is meant to
 * become a real table block (§5.17.19, the lift at every write). When a lift control refuses it
 * (a figure the facts do not state, currency, a ragged row, the caps) or the text is the cover
 * letter (never lifted: the letter carries no visuals), it stays as typed and prints as raw pipe
 * text in both files and on screen. This rule is how that becomes visible. Detection is THE one
 * detector the lift and the preview use (draft-blocks.ts hasMarkdownTable), so what this flags,
 * what the lift finds and what the preview draws cannot disagree. Every resolved span is scanned
 * (paragraphs, the letter, every block string). A block cell or caption is cleaned to one line by
 * every write path (draft-blocks `clean`), so a drafted or lifted visual never matches; a stored
 * string from outside those paths that does hold one is flagged truthfully (it prints raw), and
 * its recipe is a person's edit (check-fixes.ts). One finding per span, located at the first table's
 * header line. The suggestion is the one thing that differs for the letter: a table is never the
 * answer there.
 */
export const D6: Rule = {
  id: "D6",
  title: "Tabular text in prose",
  severity: "warn",
  check: (ctx) => {
    const violations = [];

    for (const span of textSpans(ctx)) {
      if (typeof span.text !== "string" || !hasMarkdownTable(span.text)) continue;
      const index = firstTableOffset(span.text);
      const lineEnd = span.text.indexOf("\n", index);
      const lineLength = (lineEnd === -1 ? span.text.length : lineEnd) - index;
      violations.push(
        violation({
          ruleId: "D6",
          severity: "warn",
          message:
            "A pipe-formatted table sits in the text. It prints as raw text with pipes and dashes, in the document and on screen, not as a table.",
          locator: {
            ...(span.sectionId ? { sectionId: span.sectionId } : {}),
            ...(span.blockId ? { blockId: span.blockId } : {}),
            field: span.field,
            charOffset: index,
          },
          excerpt: excerptAround(span.text, index, Math.min(lineLength, 80)),
          suggestion:
            span.location === "letter"
              ? "Rewrite it as prose: the cover letter never carries a table."
              : "Ask Tron to present it as a real table (every figure must match the facts exactly), or rewrite it as prose.",
        }),
      );
    }

    return violations;
  },
};

export const D_RULES: Rule[] = [D1, D2, D3, D4, D5, D6];
