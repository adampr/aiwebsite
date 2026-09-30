// Fix-it recipes for the Checks pane (ARCHITECTURE.md §5.17.8).
//
// Maps one gate violation to the action that actually resolves it: a Tron
// revision on the section the locator points at (the common case), a full
// per-section redraft (rule C1's own text: rebuild, do not patch), a pointer
// at the pricing questionnaire (the prose never carries figures the engine
// did not produce, so prose surgery cannot fix a quote), or a plain message
// when nothing in the draft causes the finding.
//
// CLIENT-SAFE by contract: imported by workspace.tsx, so no lookbehind
// regexes (a `(?<` in a client chunk is a repo red flag — core-js probes
// aside) and no server imports. letter.ts qualifies (workspace already
// imports DOC_LABEL from it, and it carries no lookbehind).

import { DOC_LABEL } from "./letter";
import type { Violation } from "./content-model/gate";

/**
 * The section-id form resolve-draft.ts mints (its line ~157). The two MUST
 * stay in lockstep: this is how a locator's `sec_*` id is mapped back to the
 * stored section label the Tron route keys on.
 */
export const sectionIdForLabel = (label: string): string =>
  "sec_" + label.replace(/[^a-zA-Z0-9]+/g, "_");

const sanitizeLabel = (label: string): string =>
  label.replace(/[^a-zA-Z0-9]+/g, "_");

/**
 * Which stored section a violation points at, or null when the locator names
 * nothing section-shaped (a document-wide phrase scan, a pricing recompute).
 *
 *   - locator.sectionId matches a drafted section's sectionIdForLabel;
 *   - else locator.requirementId maps through the requirement's
 *     structureLabel (returned even when no section with that label is
 *     drafted yet — the caller decides what undrafted means);
 *   - else locator.blockId is parsed against resolve-draft's two id shapes,
 *     `b_<sanitized label>_<paragraph index>` and
 *     `bv_<sanitized label>_<stored id>`. Sanitized labels are ambiguous as
 *     prefixes ("1" and "1.2" both prefix-match "b_1_2_3"), so every
 *     drafted label is tested and the LONGEST sanitized match wins.
 */
export function resolveTargetLabel(
  v: Violation,
  sections: { label: string }[],
  requirements: { id: string; structureLabel: string }[]
): string | null {
  const loc = v.locator;
  if (loc.sectionId) {
    const hit = sections.find(
      (s) => sectionIdForLabel(s.label) === loc.sectionId
    );
    if (hit) return hit.label;
  }
  if (loc.requirementId) {
    const req = requirements.find((r) => r.id === loc.requirementId);
    if (req) return req.structureLabel;
  }
  if (loc.blockId) {
    let best: string | null = null;
    let bestLen = -1;
    for (const s of sections) {
      const sanitized = sanitizeLabel(s.label);
      if (!sanitized) continue;
      for (const prefix of [`b_${sanitized}_`, `bv_${sanitized}_`]) {
        // The char after the sanitized label must be the separator "_",
        // which the prefix's trailing underscore enforces; a bare
        // startsWith on `b_1` would also claim `b_10_2`.
        if (loc.blockId.startsWith(prefix) && sanitized.length > bestLen) {
          best = s.label;
          bestLen = sanitized.length;
        }
      }
    }
    if (best !== null) return best;
  }
  return null;
}

/**
 * A lifted reference card's block id (resolve-draft.ts liftVisual, §5.17.10):
 * `bv_<sanitized label>_<stored block id>_<n>`, the stored id being "v_" + 8
 * hex and n the card's 1-based number. An ordinary visual has no `_<n>` tail
 * and a prose block starts `b_`, so nothing else matches.
 */
const REFERENCE_CARD_BLOCK_ID = /^bv_.*_v_[0-9a-f]{8}_\d+$/;

export function isReferenceCardBlockId(blockId: string | undefined): boolean {
  return typeof blockId === "string" && REFERENCE_CARD_BLOCK_ID.test(blockId);
}

/** What a finding located on a reference card tells the person to do. */
export const REFERENCE_CARD_FIX_MESSAGE =
  "Edit the references on this section: use Edit references on the cards.";

/** What the Fix it button does for one finding. `label` may be the
 *  DOC_LABEL sentinel (the whole-document Tron plan flow). `ask` opens an
 *  optional inline context input before the Tron run fires. */
export type FixRecipe =
  | { kind: "tron"; label: string; instruction: string; ask?: { prompt: string } }
  | { kind: "redraft"; label: string; why: string }
  | { kind: "pricing"; message: string }
  | { kind: "none"; message: string };

/**
 * The revision instruction a fix rides on. It travels the EXISTING
 * `instruction` field of POST .../section, which the server fences before it
 * reaches the prompt (src/lib/rfp/brain.ts fenced()), so composing a
 * violation's message/excerpt/suggestion into it opens no new injection
 * surface — the same text already reaches the model through the draft
 * itself. Whitespace-collapsed and capped so a pathological excerpt cannot
 * blow the request. No em dashes (site-wide owner rule).
 */
export function fixInstruction(v: Violation, extra: string): string {
  const parts = [`Fix compliance finding ${v.ruleId}: ${v.message}`];
  if (v.excerpt) parts.push(` The offending text: "${v.excerpt}".`);
  if (v.suggestion)
    parts.push(` Preferred wording or direction: ${v.suggestion}`);
  const trimmed = extra.trim();
  if (trimmed) parts.push(` Additional context from the user: ${trimmed}`);
  parts.push(
    ` Change only what is needed to resolve this finding; keep everything else as it is.`
  );
  return parts.join("").replace(/\s+/g, " ").trim().slice(0, 2000);
}

/** Rules whose findings are plain prose defects a targeted Tron revision
 *  fixes, with no extra context worth asking for. */
const PLAIN_TRON_RULES = new Set([
  "A1",
  "A2",
  "A3",
  "A4",
  "A6",
  "A7",
  "A8",
  "C5",
  "C6",
  "D1",
  "D2",
  "D3",
]);

/** The B4 questionnaire pointer, verbatim per the owner contract. */
const B4_MESSAGE =
  "Answer the fully-managed split question in the pricing questionnaire; two illustrations are required while the split is unconfirmed.";

/** Every other pricing-engine finding points at the Investment sheet. */
const PRICING_MESSAGE =
  "Adjust the quantities / recompute the quote in the Investment sheet; prose never carries figures the engine did not produce.";

/**
 * Which action resolves this finding. `ctx.sections` are the DRAFTED
 * sections (the letter's reserved record may ride along; its label never
 * matches a structure label, so it is inert here).
 *
 * When no label resolves for a prose rule, the recipe still fires Tron with
 * the DOC_LABEL sentinel: the whole-document plan flow finds every
 * occurrence, which is exactly right for a document-wide phrase scan (most
 * A-rules locate one span but the phrase may appear in several).
 */
export function fixRecipe(
  v: Violation,
  ctx: {
    sections: { label: string }[];
    requirements: { id: string; structureLabel: string }[];
  }
): FixRecipe {
  // A finding on a reference card is never sent to the brain. The card's
  // cells are a third party's name, title, phone and email: composing the
  // excerpt into a revise instruction would put them in a prompt, and Tron
  // rewrites paragraphs, not cards, so the fix would not land anyway. The
  // person edits the entry where it lives. First, before any rule's recipe.
  if (isReferenceCardBlockId(v.locator.blockId))
    return { kind: "none", message: REFERENCE_CARD_FIX_MESSAGE };

  const resolved = resolveTargetLabel(v, ctx.sections, ctx.requirements);
  const tron = (ask?: { prompt: string }): FixRecipe => ({
    kind: "tron",
    label: resolved ?? DOC_LABEL,
    instruction: fixInstruction(v, ""),
    ...(ask ? { ask } : {}),
  });

  if (PLAIN_TRON_RULES.has(v.ruleId)) return tron();

  switch (v.ruleId) {
    case "A5":
      return tron({
        prompt:
          "Optional: name the real capability or fact Tron should rely on. Left blank, the uncited claim is removed or hedged.",
      });
    case "B7":
      // The locator carries only a blockId (or nothing) — resolveTargetLabel
      // already handles both; DOC_LABEL sweeps a figure quoted in furniture.
      return tron({
        prompt:
          "Optional: if this figure is legitimate, say where it comes from. Left blank, Tron removes it; computed figures belong in the pricing quote.",
      });
    case "C1":
      // The rule's own text: rebuild, do not patch. The warn variant is the
      // kb-version advisory with no cited-fact correction behind it.
      if (v.severity === "block" && resolved !== null)
        return { kind: "redraft", label: resolved, why: v.message };
      if (v.severity === "block")
        // A C1 block always carries a sectionId in practice; if the section
        // is gone from the draft there is nothing to redraft, so fall back
        // to the whole-document Tron sweep rather than a dead button.
        return tron();
      return {
        kind: "none",
        message:
          "Advisory only. Redraft a section to pick up the newer knowledge base when it matters.",
      };
    case "C2":
      return {
        kind: "none",
        message:
          "Internal parity regression. Nothing in the draft causes this; report it.",
      };
    case "C3": {
      const label = resolved;
      if (label === null) return tron();
      const drafted = ctx.sections.some((s) => s.label === label);
      if (!drafted)
        return {
          kind: "none",
          message: `Draft section ${label} first; this requirement is answered there.`,
        };
      return {
        kind: "tron",
        label,
        instruction: fixInstruction(v, ""),
        ask: {
          prompt:
            "Optional: anything Tron should use to answer this requirement.",
        },
      };
    }
    case "C4":
      return {
        kind: "none",
        message:
          "Structural: the section labels/order came from ingest. Fix the structure via Tron's retitle/remove or re-ingest.",
      };
    case "B1":
    case "B3":
    case "B5":
      return { kind: "pricing", message: PRICING_MESSAGE };
    case "B4":
      return { kind: "pricing", message: B4_MESSAGE };
    case "B2":
      // The hedge/pro-rated scans carry an excerpt (and usually a span
      // locator): prose Tron can rewrite. The illustration-floor finding has
      // neither (empty locator, engine arithmetic): only the quote fixes it.
      return v.excerpt || v.locator.sectionId || v.locator.blockId
        ? tron()
        : { kind: "pricing", message: PRICING_MESSAGE };
    case "B6":
      // Two shapes, neither with a locator, told apart by the sentence they
      // carry: the optional-vs-included contradiction names a service in
      // prose (Tron fixes the wording); the undeclared-pass-through finding
      // is a quote-shape gap only the pricing sheet resolves.
      return v.message.includes("optional and included")
        ? tron()
        : { kind: "pricing", message: PRICING_MESSAGE };
    case "D4":
      // The edge-of-range variant is document-level (no section locator) and
      // benefits from context about the client's size; the per-section
      // missing-forward-commitment variant is a plain rewrite.
      return v.locator.sectionId === undefined
        ? tron({
            prompt:
              "Optional: context on the client's size or fit worth naming.",
          })
        : tron();
    case "D5":
      return tron();
    default:
      // A rule added after this map still gets a working button: Tron on the
      // resolved section, else the whole-document sweep.
      return tron();
  }
}
