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
  return fixInstructionFor([v], extra);
}

/** Whitespace-collapsed text, the one normalizer grouping and the
 *  instruction's dedupe share (two spans of one phrase differ only in
 *  wrapping, never in words). */
const collapse = (s: unknown): string =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();

/** Distinct non-empty values, first appearance first, compared collapsed.
 *  The RAW first value is kept (the instruction's final pass collapses it),
 *  so a one-member instruction keeps the exact bytes it always had. */
function distinctTexts(values: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const c = collapse(raw);
    if (!c || seen.has(c)) continue;
    seen.add(c);
    out.push(raw as string);
  }
  return out;
}

/**
 * The instruction for one or more findings that share a rule and a message
 * (a grouped row, §5.17.8): the message is said ONCE, then every distinct
 * offending text, so one Tron turn resolves every place the finding
 * appears. A single member composes byte-for-byte what fixInstruction always
 * did (the one-excerpt and one-suggestion wordings are the old ones), which
 * keeps every existing recipe and its pinned tests unchanged.
 */
export function fixInstructionFor(members: Violation[], extra: string): string {
  const first = members[0];
  if (!first) return "";
  const parts = [`Fix compliance finding ${first.ruleId}: ${first.message}`];
  const excerpts = distinctTexts(members.map((m) => m.excerpt));
  if (excerpts.length === 1)
    parts.push(` The offending text: "${excerpts[0]}".`);
  else if (excerpts.length > 1) {
    // A long group (D1 emits one finding per em dash) names the first few
    // places and counts the rest: the whole-document sweep finds them all,
    // and listing sixty would crowd everything else out of the cap.
    const shown = excerpts.slice(0, MAX_LISTED_EXCERPTS);
    const more = excerpts.length - shown.length;
    parts.push(
      ` The offending text, in each place it appears: ${shown
        .map((e) => `"${e}"`)
        .join("; ")}${more > 0 ? ` and ${more} more place${more === 1 ? "" : "s"}` : ""}.`
    );
  }
  const suggestions = distinctTexts(members.map((m) => m.suggestion)).slice(
    0,
    MAX_LISTED_EXCERPTS
  );
  if (suggestions.length)
    parts.push(` Preferred wording or direction: ${suggestions.join("; ")}`);
  // The user's context and the "change only what is needed" guard go LAST
  // and are never cut: the cap trims the finding text before them, so a
  // pathological message or excerpt list can never drop the guard or what
  // the person typed. The context has its own bound so it cannot starve
  // the finding itself.
  const tail: string[] = [];
  const trimmed = extra.trim().slice(0, MAX_CONTEXT_CHARS);
  if (trimmed) tail.push(`Additional context from the user: ${trimmed}`);
  tail.push(
    members.length > 1
      ? `Change only what is needed to resolve this finding in every place it appears; keep everything else as it is.`
      : `Change only what is needed to resolve this finding; keep everything else as it is.`
  );
  const tailText = collapse(tail.join(" "));
  const room = INSTRUCTION_CAP - tailText.length - 1;
  const head = collapse(parts.join("")).slice(0, Math.max(0, room)).trimEnd();
  return head ? `${head} ${tailText}` : tailText;
}

/** The composed instruction's cap (the request stays small). */
const INSTRUCTION_CAP = 2000;
/** How many distinct excerpts (and suggestions) a grouped instruction lists. */
const MAX_LISTED_EXCERPTS = 6;
/** The bound on the person's own context inside one instruction. */
const MAX_CONTEXT_CHARS = 800;

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

/* ---- grouped findings and the Fix all round (§5.17.8) -------------------- */

/**
 * One row in the Checks pane: every visible finding that shares a rule id and
 * a (whitespace-collapsed) message. The phrase scans emit one violation per
 * TEXT SPAN (validators/rule.ts scanForbiddenPhrases), so a phrase used in two
 * paragraphs arrived as two identical rows; grouped, it is one row "in 2
 * places". Members keep their own findingSig, so Ignore still persists one
 * dismissal per stored violation and the persisted format is untouched.
 */
export type FindingGroup = {
  key: string;
  ruleId: string;
  /** "block" when any member blocks, else the first member's. */
  severity: Violation["severity"];
  /** The first member's message. */
  message: string;
  /** The first member's, when present (C1's split instants). */
  timedMessage?: Violation["timedMessage"];
  /** In original order. */
  members: Violation[];
};

/** The grouping key: rule id plus the collapsed message. */
export const groupKeyFor = (v: Violation): string =>
  `${v.ruleId}\u0000${collapse(v.message)}`;

/**
 * Group violations for display. The CALLER filters (visible rows pass only
 * undismissed findings, the Ignored list only dismissed ones); this never
 * reads `dismissed`. Groups come out in order of first appearance.
 */
export function groupFindings(violations: Violation[]): FindingGroup[] {
  const byKey = new Map<string, FindingGroup>();
  const out: FindingGroup[] = [];
  for (const v of violations) {
    const key = groupKeyFor(v);
    const hit = byKey.get(key);
    if (hit) {
      hit.members.push(v);
      if (v.severity === "block") hit.severity = "block";
      continue;
    }
    const g: FindingGroup = {
      key,
      ruleId: v.ruleId,
      severity: v.severity,
      message: v.message,
      ...(v.timedMessage ? { timedMessage: v.timedMessage } : {}),
      members: [v],
    };
    byKey.set(key, g);
    out.push(g);
  }
  return out;
}

/** One action a grouped row's Fix it (or the Fix all round) takes. Same
 *  shapes as FixRecipe. */
export type FixStep = FixRecipe;

type FixCtx = {
  sections: { label: string }[];
  requirements: { id: string; structureLabel: string }[];
};

/**
 * What fixes a whole group:
 *
 *   - tron recipes collapse to AT MOST ONE step: the one label they share,
 *     or DOC_LABEL when they name two or more labels or any of them already
 *     resolved to DOC_LABEL (the whole-document sweep finds every
 *     occurrence, exactly the duplicate-phrase case). The instruction names
 *     the message once and every member's excerpt (fixInstructionFor). The
 *     `ask` prompt survives only when every collapsed member had the same one;
 *   - redraft steps stay one per label;
 *   - pricing/none steps dedupe by message (first kind wins).
 *
 * Steps come out in order of the first member that produced each.
 */
export function groupFixPlan(g: FindingGroup, ctx: FixCtx): FixStep[] {
  type Slot =
    | { kind: "tron" }
    | { kind: "redraft"; step: FixStep }
    | { kind: "note"; step: FixStep };
  const slots: Slot[] = [];
  const tronMembers: Violation[] = [];
  const tronLabels = new Set<string>();
  const tronAsks: (string | undefined)[] = [];
  const redraftLabels = new Set<string>();
  const notes = new Set<string>();
  for (const m of g.members) {
    const r = fixRecipe(m, ctx);
    if (r.kind === "tron") {
      if (tronMembers.length === 0) slots.push({ kind: "tron" });
      tronMembers.push(m);
      tronLabels.add(r.label);
      tronAsks.push(r.ask?.prompt);
      continue;
    }
    if (r.kind === "redraft") {
      if (redraftLabels.has(r.label)) continue;
      redraftLabels.add(r.label);
      slots.push({ kind: "redraft", step: r });
      continue;
    }
    if (notes.has(r.message)) continue;
    notes.add(r.message);
    slots.push({ kind: "note", step: r });
  }
  return slots.map((s): FixStep => {
    if (s.kind !== "tron") return s.step;
    const label =
      tronLabels.size === 1 && !tronLabels.has(DOC_LABEL)
        ? [...tronLabels][0]
        : DOC_LABEL;
    const first = tronAsks[0];
    const sameAsk =
      first !== undefined && tronAsks.every((a) => a === first);
    return {
      kind: "tron",
      label,
      instruction: fixInstructionFor(tronMembers, ""),
      ...(sameAsk ? { ask: { prompt: first } } : {}),
    };
  });
}

/** The members of a group whose own recipe is a Tron run: what a grouped
 *  Fix it's optional-context editor recomposes its instruction from. */
export function tronMembersOf(g: FindingGroup, ctx: FixCtx): Violation[] {
  return g.members.filter((m) => fixRecipe(m, ctx).kind === "tron");
}

/**
 * Rules the Fix all round never touches, whatever their recipe. B7 (an
 * unsourced figure): with blank context Tron removes the figure, which may
 * be legitimate, so a person decides; the row's own Fix it still offers the
 * context editor. The receipt names these as remaining for the person.
 */
export const AUTO_EXCLUDED_RULES: ReadonlySet<string> = new Set(["B7"]);

/** Whether the Fix all round would act on this row (the button's count). */
export function isAutoFixableGroup(g: FindingGroup, ctx: FixCtx): boolean {
  return !AUTO_EXCLUDED_RULES.has(g.ruleId) && isAutoFixable(groupFixPlan(g, ctx));
}

/** True when the plan holds something the machine can do unattended. */
export function isAutoFixable(steps: FixStep[]): boolean {
  return steps.some((s) => s.kind === "tron" || s.kind === "redraft");
}

/** The request cap one merged instruction must stay under (the recipe's own
 *  2000-char cap, so a merged step is never larger than a single one). */
export const FIX_ALL_INSTRUCTION_CAP = 2000;

/**
 * Pack whole instructions into space-joined chunks under the cap. A plain
 * join-then-slice would cut the later findings (and their closing "change
 * only what is needed" guard) off mid-sentence; an instruction that alone
 * exceeds the cap is already capped by its composer.
 */
function packInstructions(instructions: string[]): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ins of instructions) {
    if (!ins) continue;
    if (!cur) {
      cur = ins;
      continue;
    }
    if (cur.length + 1 + ins.length <= FIX_ALL_INSTRUCTION_CAP) {
      cur = `${cur} ${ins}`;
      continue;
    }
    out.push(cur);
    cur = ins;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * One pass of the Fix all round: every auto-fixable step across the visible
 * groups, deduped and ordered for sequential execution.
 *
 *   1. redrafts, one per label (C1's rebuild; run first so nothing is
 *      revised and then thrown away by the rebuild);
 *   2. Tron revisions per section label, instructions merged in group
 *      order; a label being redrafted this pass is skipped (the rebuild
 *      replaces its text; anything that survives it gets the next pass);
 *   3. the whole-document sweep LAST, carrying the union of every DOC_LABEL
 *      instruction, so its plan reads text the section fixes already
 *      changed.
 *
 * Pricing and none steps never appear: they wait for the person, and so do
 * the rules in AUTO_EXCLUDED_RULES. `ask` prompts are dropped, since the
 * round runs every other recipe with blank context (A5, C3 and D4 state a
 * blank default that is the safe direction).
 *
 * `opts.noRedraft` names labels the round already rebuilt: rule C1 compares
 * against the proposal's creation time (rules-c.ts), so a rebuilt section
 * citing the corrected fact is reported again, and redrafting it on every
 * pass would loop. Those labels get no redraft step (and so their Tron
 * steps are no longer suppressed).
 */
export function fixAllSteps(
  groups: FindingGroup[],
  ctx: FixCtx,
  opts: { noRedraft?: ReadonlySet<string> } = {}
): FixStep[] {
  const redrafts: FixStep[] = [];
  const redraftLabels = new Set<string>();
  const tronOrder: string[] = [];
  const tronByLabel = new Map<string, string[]>();
  for (const g of groups) {
    if (AUTO_EXCLUDED_RULES.has(g.ruleId)) continue;
    for (const step of groupFixPlan(g, ctx)) {
      if (step.kind === "redraft") {
        if (opts.noRedraft?.has(step.label)) continue;
        if (redraftLabels.has(step.label)) continue;
        redraftLabels.add(step.label);
        redrafts.push(step);
      } else if (step.kind === "tron") {
        const list = tronByLabel.get(step.label);
        if (list) list.push(step.instruction);
        else {
          tronByLabel.set(step.label, [step.instruction]);
          tronOrder.push(step.label);
        }
      }
    }
  }
  const trons: FixStep[] = [];
  const docs: FixStep[] = [];
  for (const label of tronOrder) {
    if (redraftLabels.has(label)) continue;
    for (const instruction of packInstructions(tronByLabel.get(label) ?? []))
      (label === DOC_LABEL ? docs : trons).push({
        kind: "tron",
        label,
        instruction,
      });
  }
  return [...redrafts, ...trons, ...docs];
}
