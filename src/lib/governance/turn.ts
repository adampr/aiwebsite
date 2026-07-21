// Turn parsing, validation, and apply (§5.12). The model's JSON is never
// trusted: slugs against the kind's blueprint allowlist, size caps, section
// caps, markdown sanitization + injection screen at apply, and a host-side
// review gate (the drafting->review flip only happens when the host-computed
// coverage of required bank items is complete, no matter what the model says).

import type {
  DocOp,
  DocSection,
  GovernanceDoc,
  GovernanceKind,
  NextQuestion,
  TurnResult,
} from "./types";
import { CAPS, REVIEW_FORCED_SUMMARY, withOpenItemsNote } from "./config";
import {
  countConfirmMarkers,
  findConfirmMarkers,
  sanitizeMarkdown,
} from "./markdown";
import { screenInjection } from "./research";
import { bankById, docSlugAllowlist, requiredBankIds } from "./blueprints";

/* ------------------------------------------------------------------ *
 * Extraction + lenient parse
 * ------------------------------------------------------------------ */

export function extractJson(raw: string): string | null {
  let s = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```\s*$/m.exec(s);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/** One deterministic cleanup pass for near-JSON (trailing commas, quotes). */
function sanitizeJsonish(s: string): string {
  return s
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/^\s*\/\/.*$/gm, "");
}

export function parseTurnJson(raw: string): unknown | null {
  const extracted = extractJson(raw);
  if (!extracted) return null;
  try {
    return JSON.parse(extracted);
  } catch {
    try {
      return JSON.parse(sanitizeJsonish(extracted));
    } catch {
      return null;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

const KEBAB = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}

/** Shared lenient coercion for open_item_guesses shapes (validateTurn and
 *  the backfill parser): junk filters to [], never an error. Extracted
 *  behavior-identical from validateTurn (§5.12 round 2). */
export function coerceGuessEntries(
  v: unknown
): { excerpt: string; guesses: string[] }[] {
  return (Array.isArray(v) ? v : [])
    .flatMap((e): { excerpt: string; guesses: string[] }[] => {
      const r = e as Record<string, unknown>;
      const excerpt = str(r.excerpt, 400) ?? str(r.marker, 400);
      const guesses = Array.isArray(r.guesses)
        ? r.guesses
            .filter(
              (g): g is string =>
                typeof g === "string" &&
                g.trim().length > 0 &&
                g.length <= CAPS.openItemGuessMaxChars
            )
            .slice(0, CAPS.openItemGuessesPerItem)
        : [];
      return excerpt && guesses.length ? [{ excerpt, guesses }] : [];
    })
    .slice(0, CAPS.openItemGuessesMaxKeys);
}

/** Backfill-call response parse (§5.12 round 2): one JSON object carrying
 *  only open_item_guesses. Fully lenient standalone: unparseable or
 *  malformed output degrades to [] and the turn proceeds guess-less. */
export function parseBackfillGuesses(
  raw: string
): { excerpt: string; guesses: string[] }[] {
  const parsed = parseTurnJson(raw);
  if (typeof parsed !== "object" || parsed === null) return [];
  return coerceGuessEntries(
    (parsed as Record<string, unknown>).open_item_guesses
  );
}

export interface TurnValidation {
  ok: boolean;
  turn?: TurnResult;
  errors: string[];
  // Turn zero only: the individually valid ops from an INVALID turn, trimmed
  // front-to-back to the turn-zero markdown budget. Turn zero consumes only
  // doc_ops (the host asks the first question itself), so applying these is
  // always safe; the answer route stays all-or-nothing and gets [].
  salvageOps: DocOp[];
}

export function validateTurn(
  parsed: unknown,
  kind: GovernanceKind,
  // nonAdvancing (restyle/amend turns, §5.12): the host preserves status and
  // question itself, so validation is status-agnostic: neither a question
  // nor a review_summary is required, any returned question is discarded,
  // and a well-formed review_summary is kept as optional input.
  opts: { turnZero?: boolean; nonAdvancing?: boolean } = {}
): TurnValidation {
  const errors: string[] = [];
  if (typeof parsed !== "object" || parsed === null)
    return { ok: false, errors: ["not an object"], salvageOps: [] };
  const o = parsed as Record<string, unknown>;
  const allow = docSlugAllowlist(kind);
  const opBudget = opts.turnZero
    ? CAPS.turnZeroOpMarkdownMaxChars
    : CAPS.turnOpMarkdownMaxChars;
  const maxOps = opts.turnZero ? CAPS.turnZeroMaxOps : CAPS.maxOpsPerTurn;

  const rawOps = Array.isArray(o.doc_ops) ? o.doc_ops : [];
  if (!Array.isArray(o.doc_ops)) errors.push("doc_ops must be an array");
  if (rawOps.length > maxOps) errors.push(`too many ops (max ${maxOps})`);

  const ops: DocOp[] = [];
  let mdTotal = 0;
  for (const [i, op] of rawOps.slice(0, maxOps).entries()) {
    const e = op as Record<string, unknown>;
    const doc = str(e.doc, 64);
    if (!doc || !allow.has(doc)) {
      errors.push(`op ${i}: doc slug not in allowlist`);
      continue;
    }
    switch (e.op) {
      case "create_doc":
      case "retitle_doc": {
        const title = str(e.title, 200);
        if (!title) errors.push(`op ${i}: bad title`);
        else ops.push({ op: e.op, doc, title });
        break;
      }
      case "upsert_section": {
        const section = str(e.section, 64);
        const title = str(e.title, 200);
        const markdown = str(e.markdown, CAPS.sectionMarkdownMaxChars);
        if (!section || !KEBAB.test(section))
          errors.push(`op ${i}: bad section id`);
        else if (!title) errors.push(`op ${i}: bad section title`);
        else if (!markdown)
          errors.push(
            `op ${i}: markdown missing or over ${CAPS.sectionMarkdownMaxChars} chars`
          );
        else {
          mdTotal += markdown.length;
          ops.push({ op: "upsert_section", doc, section, title, markdown });
        }
        break;
      }
      case "remove_section": {
        const section = str(e.section, 64);
        if (!section) errors.push(`op ${i}: bad section id`);
        else ops.push({ op: "remove_section", doc, section });
        break;
      }
      case "set_stub": {
        const markdown = str(e.markdown, CAPS.sectionMarkdownMaxChars);
        if (typeof e.stub !== "boolean" || !markdown)
          errors.push(`op ${i}: set_stub needs boolean stub + markdown`);
        else ops.push({ op: "set_stub", doc, stub: e.stub, markdown });
        break;
      }
      case "reorder_sections": {
        // Structure adoption (§5.12): shape-checked here, permutation-checked
        // against the live doc in applyOps (the doc can change between ops).
        const order = Array.isArray(e.order)
          ? e.order.filter(
              (s): s is string => typeof s === "string" && KEBAB.test(s)
            )
          : [];
        const unique = new Set(order);
        if (
          !order.length ||
          order.length > CAPS.maxSectionsPerDoc ||
          unique.size !== order.length ||
          (Array.isArray(e.order) && e.order.length !== order.length)
        )
          errors.push(`op ${i}: reorder_sections needs unique kebab ids`);
        else ops.push({ op: "reorder_sections", doc, order });
        break;
      }
      case "adopt_outline": {
        // Skeleton adoption (§5.12 round 18b): shape-checked here,
        // partition-checked against the live doc in applyOps.
        const raw = Array.isArray(e.buckets) ? e.buckets : [];
        const buckets: { title: string; sections: string[] }[] = [];
        let shapeOk = raw.length > 0 && raw.length <= CAPS.maxSectionsPerDoc;
        for (const b of raw) {
          const bo = b as Record<string, unknown>;
          const title = str(bo.title, 80);
          const secs = Array.isArray(bo.sections)
            ? bo.sections.filter(
                (x): x is string => typeof x === "string" && KEBAB.test(x)
              )
            : [];
          if (
            !title ||
            !secs.length ||
            (Array.isArray(bo.sections) && bo.sections.length !== secs.length)
          ) {
            shapeOk = false;
            break;
          }
          buckets.push({ title, sections: secs });
        }
        if (!shapeOk)
          errors.push(
            `op ${i}: adopt_outline needs 1-${CAPS.maxSectionsPerDoc} buckets, each a title plus kebab section ids`
          );
        else ops.push({ op: "adopt_outline", doc, buckets });
        break;
      }
      default:
        errors.push(`op ${i}: unknown op`);
    }
  }
  if (mdTotal > opBudget)
    errors.push(`total op markdown ${mdTotal} over budget ${opBudget}`);

  const status = o.status === "review" ? "review" : o.status === "asking" ? "asking" : null;
  if (!status) errors.push('status must be "asking" or "review"');

  let question: TurnResult["question"] = null;
  if (o.question !== null && o.question !== undefined) {
    const q = o.question as Record<string, unknown>;
    const text = str(q.text, 500);
    const why = str(q.why, 300) ?? "";
    const bank = bankById(kind);
    const bankId =
      typeof q.bankId === "string" && bank.has(q.bankId) ? q.bankId : null;
    const suggestions = Array.isArray(q.suggestions)
      ? q.suggestions
          .filter((s): s is string => typeof s === "string" && s.length <= 80)
          .slice(0, 4)
      : [];
    if (!text) errors.push("question.text missing or too long");
    else question = { bankId, text, why, suggestions };
  }
  if (status === "review" && !opts.nonAdvancing && !str(o.review_summary, 800))
    errors.push("review requires review_summary (max 800 chars)");
  if (status === "asking" && !question && !opts.turnZero && !opts.nonAdvancing)
    errors.push("asking requires a question");

  const bank = bankById(kind);
  const answeredBankIds = Array.isArray(o.answered_bank_ids)
    ? o.answered_bank_ids.filter(
        (id): id is string => typeof id === "string" && bank.has(id)
      )
    : [];

  // Open-item best guesses (§5.12): LENIENT by contract. This field must
  // never fail an otherwise valid turn or trigger the repair call, so junk
  // shapes filter to [] and nothing here ever pushes to errors[]. Caps are
  // re-enforced at merge time (guesses.ts); this trim just bounds transport.
  const openItemGuesses = coerceGuessEntries(o.open_item_guesses);

  if (errors.length) {
    // Salvage trim mirrors mdTotal above: only upsert_section markdown
    // counts against the budget; drop (never truncate) an op that would
    // exceed it. Non-turn-zero callers get [] and stay all-or-nothing.
    let salvageOps: DocOp[] = [];
    if (opts.turnZero) {
      let acc = 0;
      salvageOps = ops.filter((op) => {
        if (op.op !== "upsert_section") return true;
        if (acc + op.markdown.length > opBudget) return false;
        acc += op.markdown.length;
        return true;
      });
    }
    return { ok: false, errors, salvageOps };
  }
  return {
    ok: true,
    errors: [],
    salvageOps: [],
    turn: {
      docOps: ops,
      status: status as "asking" | "review",
      question: opts.nonAdvancing ? null : question,
      reviewSummary: opts.nonAdvancing
        ? str(o.review_summary, 800)
        : status === "review"
          ? (o.review_summary as string)
          : null,
      answeredBankIds,
      openItemGuesses,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Apply
 * ------------------------------------------------------------------ */

export interface ApplyResult {
  documents: GovernanceDoc[];
  changedSections: Record<string, string[]>;
  injectionHits: string[];
  errors: string[];
}

export function applyOps(
  documents: GovernanceDoc[],
  ops: DocOp[],
  kind: GovernanceKind
): ApplyResult {
  const docs: GovernanceDoc[] = documents.map((d) => ({
    ...d,
    sections: d.sections.map((s) => ({ ...s })),
  }));
  const changed: Record<string, Set<string>> = {};
  const injectionHits: string[] = [];
  const errors: string[] = [];
  const allow = docSlugAllowlist(kind);

  const mark = (slug: string, section: string) => {
    (changed[slug] ??= new Set()).add(section);
  };
  const find = (slug: string) => docs.find((d) => d.slug === slug);

  const cleanMd = (md: string): string => {
    const sanitized = sanitizeMarkdown(md);
    const { clean, hits } = screenInjection(sanitized);
    injectionHits.push(...hits);
    return clean;
  };

  for (const op of ops) {
    if (!allow.has(op.doc)) continue; // validated already; belt and braces
    switch (op.op) {
      case "create_doc": {
        if (find(op.doc)) break;
        if (docs.length >= CAPS.maxDocsPerProject) {
          errors.push("doc cap reached");
          break;
        }
        docs.push({ slug: op.doc, title: op.title, stub: false, sections: [] });
        break;
      }
      case "retitle_doc": {
        const d = find(op.doc);
        if (d) d.title = op.title;
        break;
      }
      case "upsert_section": {
        const d = find(op.doc);
        if (!d) {
          errors.push(`upsert into missing doc ${op.doc}`);
          break;
        }
        const md = cleanMd(op.markdown);
        const existing = d.sections.find((s) => s.id === op.section);
        if (existing) {
          existing.title = op.title;
          existing.markdown = md;
        } else if (d.sections.length >= CAPS.maxSectionsPerDoc) {
          errors.push(`section cap reached on ${op.doc}`);
          break;
        } else {
          d.sections.push({ id: op.section, title: op.title, markdown: md });
        }
        d.stub = false; // a real section un-stubs the doc
        mark(op.doc, op.section);
        break;
      }
      case "remove_section": {
        const d = find(op.doc);
        if (!d) break;
        const idx = d.sections.findIndex((s) => s.id === op.section);
        if (idx !== -1) {
          d.sections.splice(idx, 1);
          mark(op.doc, op.section);
          // Keep an adopted outline consistent: the removed id leaves its
          // bucket; a bucket emptied by removals disappears (render is
          // lenient anyway, this just keeps the stored shape honest).
          if (d.outline) {
            d.outline = d.outline
              .map((b) => ({
                title: b.title,
                sections: b.sections.filter((id) => id !== op.section),
              }))
              .filter((b) => b.sections.length > 0);
            if (!d.outline.length) delete d.outline;
          }
        }
        break;
      }
      case "set_stub": {
        const d = find(op.doc);
        if (!d) break;
        d.stub = op.stub;
        const md = cleanMd(op.markdown);
        const stubSection: DocSection = {
          id: "determination",
          title: "Determination",
          markdown: md,
        };
        const existing = d.sections.find((s) => s.id === "determination");
        if (existing) existing.markdown = md;
        else d.sections.unshift(stubSection);
        mark(op.doc, "determination");
        break;
      }
      case "reorder_sections": {
        // Structure adoption (§5.12): all-or-nothing. `order` must be an
        // exact permutation of the doc's CURRENT section ids; anything else
        // (missing id, invented id, wrong length) rejects the op untouched,
        // so a reorder can never drop or duplicate a section. Only sections
        // whose position actually moved are marked changed.
        const d = find(op.doc);
        if (!d) break;
        const current = new Set(d.sections.map((s) => s.id));
        if (
          op.order.length !== d.sections.length ||
          !op.order.every((id) => current.has(id))
        ) {
          errors.push(`reorder on ${op.doc} is not a permutation; ignored`);
          break;
        }
        const byId = new Map(d.sections.map((s) => [s.id, s]));
        const before = d.sections.map((s) => s.id);
        d.sections = op.order.map((id) => byId.get(id)!);
        op.order.forEach((id, i) => {
          if (before[i] !== id) mark(op.doc, id);
        });
        break;
      }
      case "adopt_outline": {
        // Skeleton adoption (§5.12 round 18b): all-or-nothing like reorder.
        // The buckets must partition the doc's CURRENT section ids EXACTLY
        // (every id filed once, none invented), so adoption can never drop,
        // duplicate, or merge a required section. Content and titles are
        // byte-untouched: this is a presentation grouping, so NO section is
        // marked changed (marking would balloon the next prompt's verbatim
        // serialization for a zero-content-change op).
        const d = find(op.doc);
        if (!d) break;
        const filed = op.buckets.flatMap((b) => b.sections);
        const current = new Set(d.sections.map((s) => s.id));
        if (
          filed.length !== d.sections.length ||
          new Set(filed).size !== filed.length ||
          !filed.every((id) => current.has(id))
        ) {
          errors.push(`adopt_outline on ${op.doc} is not a partition; ignored`);
          break;
        }
        d.outline = op.buckets.map((b) => ({
          title: b.title,
          sections: [...b.sections],
        }));
        break;
      }
    }
  }

  return {
    documents: docs,
    changedSections: Object.fromEntries(
      Object.entries(changed).map(([k, v]) => [k, [...v]])
    ),
    injectionHits,
    errors,
  };
}

/* ------------------------------------------------------------------ *
 * Host-side review gate + question selection
 * ------------------------------------------------------------------ */

export function coverageComplete(
  kind: GovernanceKind,
  covered: Set<string>
): boolean {
  return requiredBankIds(kind).every((id) => covered.has(id));
}

/** The next unanswered required bank item, host-worded. */
export function pickNextBankQuestion(
  kind: GovernanceKind,
  covered: Set<string>,
  rev: number
): NextQuestion | null {
  const bank = bankById(kind);
  for (const [id, q] of bank) {
    if (!q.required || covered.has(id)) continue;
    return {
      id: `q_${rev}`,
      bankId: id,
      text: q.prompt,
      why: q.why,
      suggestions: q.suggestions ?? [],
      feeds: q.feeds,
    };
  }
  return null;
}

export function progressFor(
  kind: GovernanceKind,
  covered: Set<string>
): { answered: number; total: number } {
  const required = requiredBankIds(kind);
  return {
    answered: required.filter((id) => covered.has(id)).length,
    total: required.length,
  };
}

function truncTitle(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3).trimEnd() + "...";
}

/** Owner rule 2026-07-17 (§5.12): a draft is never ready for final while
 * open [TO CONFIRM] markers remain. When required coverage is complete but
 * markers are open, the host asks about them itself, one per turn, through
 * the SAME question flow as every other question (host-worded, exactly like
 * bank items). The lenient count picks the target so a malformed marker the
 * display parser misses still gets chased, in parity with the confirm gate.
 * The "qi_" id prefix marks a chase question: skipping one is the user's
 * explicit exit to review (deterministic host flip, zero AI calls). */
export function pickOpenItemQuestion(
  documents: GovernanceDoc[],
  rev: number
): NextQuestion | null {
  for (const doc of documents) {
    for (const sec of doc.sections) {
      if (countConfirmMarkers(sec.markdown) === 0) continue;
      const excerpt = findConfirmMarkers(sec.markdown)[0]?.slice(0, 80);
      const where = `the "${truncTitle(sec.title, 60)}" section of "${truncTitle(doc.title, 60)}"`;
      return {
        id: `qi_${rev}`,
        bankId: null,
        text: excerpt
          ? `In ${where} I drafted an assumption marked [TO CONFIRM: ${excerpt}]. What is the right answer here?`
          : `In ${where} an item is still marked [TO CONFIRM]. What is the right answer here?`,
        why: "A final draft cannot keep open assumptions: each one needs your call. Or skip this question to move to review and settle the rest there.",
        suggestions: [],
        feeds: [`${doc.slug}#${sec.id}`],
      };
    }
  }
  return null;
}

export interface TurnGateInput {
  kind: GovernanceKind;
  revise: boolean;
  forced: boolean; // answer cap reached this turn
  complete: boolean; // required bank coverage after merging this turn
  openTotal: number; // lenient [TO CONFIRM] count over the APPLIED docs
  documents: GovernanceDoc[]; // the applied docs (chase targets)
  covered: Set<string>;
  turn: TurnResult;
  priorSummary: string | null;
  newRev: number;
}

export interface TurnGateResult {
  status: "drafting" | "review";
  outQuestion: NextQuestion | null;
  reviewSummary: string | null;
}

/**
 * Host-side review gate (owner rule 2026-07-17): the voluntary drafting ->
 * review flip requires required-bank coverage AND zero open [TO CONFIRM]
 * markers, no matter what the model says. While markers remain after
 * coverage, the host keeps the project in drafting and chases them with
 * normal questions (pickOpenItemQuestion). Forced flips (answer cap, bank
 * exhausted) still land in review but their summary carries the honest
 * open-items note; the confirm route's zero-marker 409 stays the hard final
 * gate. Pure function so governance-tests can pin every branch.
 */
export function resolveTurnGate(g: TurnGateInput): TurnGateResult {
  if (g.revise)
    return {
      status: "review",
      outQuestion: null,
      reviewSummary: g.turn.reviewSummary ?? g.priorSummary,
    };
  if (g.forced)
    return {
      status: "review",
      outQuestion: null,
      reviewSummary: withOpenItemsNote(
        g.turn.reviewSummary ?? REVIEW_FORCED_SUMMARY,
        g.openTotal
      ),
    };
  if (g.turn.status === "review" && g.complete && g.openTotal === 0)
    return {
      status: "review",
      outQuestion: null,
      reviewSummary: g.turn.reviewSummary,
    };

  // Drafting: guarantee a next question. The open-item chase outranks the
  // model's own question once coverage is complete (one chase per turn,
  // same flow as every other question).
  let outQuestion: NextQuestion | null = null;
  if (g.complete && g.openTotal > 0)
    outQuestion = pickOpenItemQuestion(g.documents, g.newRev);
  if (!outQuestion && g.turn.question)
    outQuestion = {
      id: `q_${g.newRev}`,
      bankId: g.turn.question.bankId,
      text: g.turn.question.text,
      why: g.turn.question.why,
      suggestions: g.turn.question.suggestions,
      feeds: g.turn.question.bankId
        ? (bankById(g.kind).get(g.turn.question.bankId)?.feeds ?? [])
        : [],
    };
  if (!outQuestion)
    outQuestion = pickNextBankQuestion(g.kind, g.covered, g.newRev);
  if (!outQuestion && g.openTotal > 0)
    outQuestion = pickOpenItemQuestion(g.documents, g.newRev);
  if (!outQuestion)
    // Bank exhausted, no model question, zero markers: flip honestly.
    return {
      status: "review",
      outQuestion: null,
      reviewSummary: withOpenItemsNote(
        g.turn.reviewSummary ?? REVIEW_FORCED_SUMMARY,
        g.openTotal
      ),
    };
  return { status: "drafting", outQuestion, reviewSummary: null };
}

export interface NonAdvancingGateInput {
  kind: GovernanceKind;
  turnKind: "restyle" | "amend";
  status: "drafting" | "review"; // row.status at claim time
  storedQuestion: NextQuestion | null; // parsed nextQuestionJson
  documents: GovernanceDoc[]; // the applied docs
  openTotal: number; // lenient [TO CONFIRM] count over the applied docs
  covered: Set<string>; // UNCHANGED by non-advancing turns
  turnSummary: string | null; // model review_summary (optional input)
  priorSummary: string | null;
  newRev: number;
}

/**
 * Gate for non-advancing turns (restyle/amend, §5.12): the turn calls the
 * brain and applies doc_ops but must not consume the pending question, must
 * not change bank coverage, and preserves the project status (the one
 * exception is the defensive exhaustion fallback below, which mirrors
 * resolveTurnGate's bank-exhausted honest flip and is unreachable in
 * practice). A stored "qi_" chase question is ALWAYS re-picked: its text
 * quotes one specific marker excerpt, and an amend may have resolved exactly
 * that marker (or reworded the section) while others remain: preserving it
 * verbatim would misapply the user's next answer. Pure function so
 * governance-tests can pin every branch.
 */
export function resolveNonAdvancingGate(
  g: NonAdvancingGateInput
): TurnGateResult {
  if (g.status === "review") {
    // Amend may legitimately refresh the summary (a corrected fact changes
    // what the draft says); restyle never rewords it. Either way the summary
    // must never read ready-for-final while markers remain (owner rule).
    const summary =
      g.turnKind === "amend"
        ? (g.turnSummary ?? g.priorSummary)
        : g.priorSummary;
    return {
      status: "review",
      outQuestion: null,
      reviewSummary:
        g.turnKind === "amend" && summary
          ? withOpenItemsNote(summary, g.openTotal)
          : summary,
    };
  }
  let outQuestion: NextQuestion | null = null;
  if (g.storedQuestion && !g.storedQuestion.id.startsWith("qi_")) {
    // The pending question survives verbatim, id included: nothing derives
    // meaning from the id's rev suffix, and keeping it preserves the user's
    // typed-but-unsent sessionStorage draft for that question.
    outQuestion = g.storedQuestion;
  } else {
    outQuestion =
      pickOpenItemQuestion(g.documents, g.newRev) ??
      pickNextBankQuestion(g.kind, g.covered, g.newRev);
  }
  if (!outQuestion && g.openTotal > 0)
    outQuestion = pickOpenItemQuestion(g.documents, g.newRev);
  if (!outQuestion)
    // Defensive only: no stored question, bank exhausted, zero markers.
    return {
      status: "review",
      outQuestion: null,
      reviewSummary: withOpenItemsNote(
        g.priorSummary ?? REVIEW_FORCED_SUMMARY,
        g.openTotal
      ),
    };
  return { status: "drafting", outQuestion, reviewSummary: null };
}
