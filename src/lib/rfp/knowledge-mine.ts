// Pure rules for editing, deleting and promoting YOUR OWN knowledge rows
// from /rfp/knowledge/mine (ARCHITECTURE.md §5.17.9). No DB, no I/O, so
// scripts/rfp-knowledge-mine-tests.ts pins every branch without a server.
//
// Why a row can be edited IN PLACE here when the shared corpus never is:
// a proposal's id is what the owner's drafts cite (`pending_<id>`), and it
// is the owner's own text at the owner's own risk. A shared fact's id is
// cited by everyone, which is why corrections there mint a new row instead.
// The line between the two is `status === "approved"`: once a row has been
// minted into rfp_facts the shared fact is the truth, and this row is frozen.

import { FACT_CATEGORIES, type FactCategory } from "./content-model/knowledge";

export type KnowledgeStatus = "private" | "submitted" | "approved" | "returned";
export type KnowledgeKind = "fact" | "choice";
export type Polarity = "affirmative" | "negative";

/** Same shape addFact enforces for a shared key: a slug like contract.term. */
export const FACT_KEY_RE = /^[a-z0-9][a-z0-9._-]{2,119}$/;

/**
 * The categories a FACT may carry: the corpus's own list, so a row promoted
 * into rfp_facts is on-type there. A choice keeps whatever it has (the add
 * form's "general"); it never reaches the corpus.
 */
export const KNOWLEDGE_CATEGORIES = FACT_CATEGORIES;
export const DEFAULT_FACT_CATEGORY: FactCategory = "capability";

/** Corpus-safe category for a row about to be minted into rfp_facts. */
export function corpusCategory(category: string): FactCategory {
  return (FACT_CATEGORIES as readonly string[]).includes(category)
    ? (category as FactCategory)
    : DEFAULT_FACT_CATEGORY;
}

export type KnowledgeFields = {
  kind: KnowledgeKind;
  factKey: string | null;
  category: string;
  statement: string;
  detail: string | null;
  polarity: Polarity;
};

export type Refusal = { ok: false; code: string; message: string; status: number };

const refuse = (code: string, message: string, status = 400): Refusal => ({
  ok: false,
  code,
  message,
  status,
});

/**
 * Merge an untrusted PATCH body over the row's current fields and validate
 * the RESULT, so a partial body (only `statement`) is fine and a body that
 * flips `kind` to "fact" without a key is refused as a whole.
 */
export function normalizeKnowledgePatch(
  body: unknown,
  current: KnowledgeFields
): { ok: true; fields: KnowledgeFields } | Refusal {
  const b = (body && typeof body === "object" ? body : {}) as Record<
    string,
    unknown
  >;

  const kind: KnowledgeKind =
    b.kind === undefined
      ? current.kind
      : b.kind === "fact" || b.kind === "choice"
        ? b.kind
        : "choice";

  const statement =
    b.statement === undefined ? current.statement : String(b.statement).trim();
  if (statement.length < 10)
    return refuse("invalid_request", "Write the fact out in full.");
  if (statement.length > 2000)
    return refuse("invalid_request", "Keep the statement under 2000 characters.");

  let factKey: string | null;
  if (kind === "choice") {
    factKey = null;
  } else {
    const raw =
      b.factKey === undefined ? (current.factKey ?? "") : String(b.factKey ?? "");
    factKey = raw.trim().toLowerCase();
    if (!factKey)
      return refuse(
        "invalid_request",
        "A fact needs a key, for example contract.term."
      );
    if (!FACT_KEY_RE.test(factKey))
      return refuse(
        "invalid_request",
        "The key must be a slug like contract.term (letters, digits, dots, dashes)."
      );
  }

  const detailRaw = b.detail === undefined ? current.detail : b.detail;
  const detail =
    detailRaw === null || detailRaw === undefined
      ? null
      : String(detailRaw).trim().slice(0, 2000) || null;

  const polarity: Polarity =
    b.polarity === undefined
      ? current.polarity
      : b.polarity === "negative"
        ? "negative"
        : "affirmative";

  const categoryRaw =
    b.category === undefined ? current.category : String(b.category);
  let category = categoryRaw.trim().toLowerCase().slice(0, 60) || "general";
  if (kind === "fact") {
    // A fact's category must be one the corpus knows, or the row that
    // approval mints is off-type in rfp_facts. An untouched legacy
    // "general" (the add form's old default) is steered, not refused.
    if (b.category === undefined && category === "general")
      category = DEFAULT_FACT_CATEGORY;
    if (!(FACT_CATEGORIES as readonly string[]).includes(category))
      return refuse("invalid_request", "Pick a category from the list.");
  } else if (!/^[a-z][a-z0-9-]*$/.test(category)) {
    return refuse("invalid_request", "Pick a category from the list.");
  }

  return { ok: true, fields: { kind, factKey, category, statement, detail, polarity } };
}

export type KnowledgeAction = "submit" | "withdraw" | "promote";

/**
 * Which status transitions the owner may make, and what promotion needs.
 *
 *   submit    private | returned  -> submitted    (fact with a key)
 *   withdraw  submitted           -> private
 *   promote   private | submitted | returned -> approved   (admin, fact, key)
 *
 * A choice is never promotable and never submittable: a decision about one
 * proposal asserted about the company poisons every future draft. Change
 * its kind first, on purpose, with a key.
 */
export function knowledgeTransition(
  row: { status: string; kind: string; factKey: string | null },
  action: KnowledgeAction,
  caller: { admin: boolean }
): { ok: true; from: KnowledgeStatus[]; to: "submitted" | "private" | "approved" } | Refusal {
  if (row.status === "approved")
    return refuse(
      "in_shared_base",
      "This one is already in the shared base. Change it from the Shared tab.",
      409
    );

  const needsFact = (): Refusal | null => {
    if (row.kind !== "fact")
      return refuse(
        "invalid_request",
        "Only a fact about XL.net can join the shared base. Edit this and change its kind first."
      );
    if (!row.factKey)
      return refuse(
        "invalid_request",
        "Give it a fact key first, for example contract.term."
      );
    return null;
  };

  switch (action) {
    case "submit": {
      if (row.status === "submitted")
        return refuse("invalid_request", "It is already awaiting approval.", 409);
      const r = needsFact();
      if (r) return r;
      return { ok: true, from: ["private", "returned"], to: "submitted" };
    }
    case "withdraw": {
      if (row.status !== "submitted")
        return refuse("invalid_request", "Only something awaiting approval can be withdrawn.", 409);
      return { ok: true, from: ["submitted"], to: "private" };
    }
    case "promote": {
      if (!caller.admin)
        return refuse(
          "forbidden",
          "Only an XL.net admin adds straight to the shared base. Send it for approval instead.",
          403
        );
      const r = needsFact();
      if (r) return r;
      return { ok: true, from: ["private", "submitted", "returned"], to: "approved" };
    }
    default:
      return refuse("invalid_request", "action must be submit, withdraw or promote.");
  }
}

/** Deleting is the owner's call for anything not yet in the shared base. */
export function canDeleteKnowledge(row: { status: string }): true | Refusal {
  if (row.status === "approved")
    return refuse(
      "in_shared_base",
      "This one is in the shared base now. An admin retires it from the Shared tab.",
      409
    );
  return true;
}
