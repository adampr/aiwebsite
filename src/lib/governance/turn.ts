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
import { CAPS } from "./config";
import { sanitizeMarkdown } from "./markdown";
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
  opts: { turnZero?: boolean } = {}
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
  if (status === "review" && !str(o.review_summary, 800))
    errors.push("review requires review_summary (max 800 chars)");
  if (status === "asking" && !question && !opts.turnZero)
    errors.push("asking requires a question");

  const bank = bankById(kind);
  const answeredBankIds = Array.isArray(o.answered_bank_ids)
    ? o.answered_bank_ids.filter(
        (id): id is string => typeof id === "string" && bank.has(id)
      )
    : [];

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
      question,
      reviewSummary:
        status === "review" ? (o.review_summary as string) : null,
      answeredBankIds,
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
