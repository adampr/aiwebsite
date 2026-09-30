// Client references as a visual block (ARCHITECTURE.md §5.17.10).
//
// The template is a July 2026 senior-living proposal: a
// "References" section opens with one sentence, then prints ONE two-column
// table per reference under a navy "Reference N" bar, four label/value rows:
// Organization / Industry & relevance / Contact name & title / Phone & email.
//
// A stored `references` DraftBlock holds the structured entries (the person's
// answer to the references question, or contacts already on file). It is the
// ONE source every surface derives the tables from:
//   - the screen (workspace.tsx DocBlock) renders `referenceCardTables()`
//     through its existing branded-table branch,
//   - resolve-draft lifts the block into that many content-model `table`
//     blocks (generatedBy "human", no cites) plus `proposal.references`, so the
//     gate scans every cell and rule D3 sees the references, and the Word and
//     PDF emitters draw them with the table code they already have.
// So there is exactly one spec for the card, here, and no emitter learns a
// new shape.
//
// PURE and CLIENT-SAFE: no server imports, no lookbehind, no node builtins.
// The workspace, the route and the sanitizer all import it.

import type { BrandedTableBlock } from "./content-model/blocks";

/** One reference as the block stores it. Every field is a trimmed string;
 *  `referenceId` is the rfp_references row it came from, or null when the
 *  person typed a new organization. */
export type ReferenceEntry = {
  referenceId: string | null;
  organization: string;
  /** "Healthcare", "Multi-site, healthcare accreditation": the template's second row. */
  relevance: string;
  contactName: string;
  contactTitle: string;
  phone: string;
  email: string;
};

/** The stored body of the block (draft-blocks.ts adds id/after/cites/generatedBy/origin). */
export type ReferencesBody = { kind: "references"; references: ReferenceEntry[] };

export const REFERENCE_LIMITS = {
  /** Entries per block. The RFP asks for 1..10 (references-ask.ts). */
  entries: [1, 10] as const,
  organization: 120,
  relevance: 120,
  contactName: 80,
  contactTitle: 80,
  phone: 40,
  email: 120,
};

/** The first sentence of the section, from the template. Rule D3's etiquette
 *  sentence (references-ask.ts REFERENCE_ETIQUETTE_SENTENCE) follows it in the
 *  same paragraph unless the proposal already states the etiquette. */
export const REFERENCES_INTRO_SENTENCE =
  "The following comparable client references are provided.";

/** The four row labels, in template order. */
export const REFERENCE_CARD_LABELS = [
  "Organization",
  "Industry / relevance",
  "Contact name & title",
  "Phone & email",
] as const;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The same clean-up every stored block string gets (draft-blocks.ts normText):
// NFKC so a full-width digit or a ligature compares like its plain form,
// format characters and C0 controls out, every run of whitespace one space.
const FORMAT_CHARS = /[\p{Cf}\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu;

// Em dash, en dash and horizontal bar. draft-blocks.ts `clean` rewrites the em dash in model
// text because rule D1 BLOCKs on one; a typed title ("Director \u2014 IT") would trip the same
// rule from a card cell, so every dash a person types becomes a plain hyphen here.
const DASHES = /[\u2013\u2014\u2015]/g;

function squash(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v
    .normalize("NFKC")
    .replace(FORMAT_CHARS, "")
    .replace(DASHES, "-")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? null : s;
}

/**
 * Tolerant read of one entry from a request body or a stored block. Null when
 * it cannot be a reference: an organization and a contact name are required,
 * and at least one way to reach the contact (phone or email). An email that
 * is present must look like one. Everything else may be empty.
 */
export function readReferenceEntry(raw: unknown): ReferenceEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const referenceId =
    r.referenceId === null || r.referenceId === undefined
      ? null
      : typeof r.referenceId === "string" && /^[a-z0-9_\-]{1,80}$/.test(r.referenceId)
        ? r.referenceId
        : undefined;
  if (referenceId === undefined) return null;
  const organization = squash(r.organization, REFERENCE_LIMITS.organization);
  const relevance = squash(r.relevance ?? "", REFERENCE_LIMITS.relevance);
  const contactName = squash(r.contactName, REFERENCE_LIMITS.contactName);
  const contactTitle = squash(r.contactTitle ?? "", REFERENCE_LIMITS.contactTitle);
  const phone = squash(r.phone ?? "", REFERENCE_LIMITS.phone);
  const email = squash(r.email ?? "", REFERENCE_LIMITS.email);
  if (
    organization === null ||
    relevance === null ||
    contactName === null ||
    contactTitle === null ||
    phone === null ||
    email === null
  )
    return null;
  if (!organization || !contactName) return null;
  if (!phone && !email) return null;
  if (email && !EMAIL.test(email)) return null;
  return { referenceId, organization, relevance, contactName, contactTitle, phone, email };
}

/** Read a whole `references` array; null when any entry is unreadable or the count is out of range. */
export function readReferenceEntries(raw: unknown): ReferenceEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const [min, max] = REFERENCE_LIMITS.entries;
  if (raw.length < min || raw.length > max) return null;
  const out: ReferenceEntry[] = [];
  for (const item of raw) {
    const e = readReferenceEntry(item);
    if (!e) return null;
    out.push(e);
  }
  return out;
}

/** "Alex Rivera, COO"; the name alone when there is no title. */
export function referenceContactLine(e: ReferenceEntry): string {
  return e.contactTitle ? `${e.contactName}, ${e.contactTitle}` : e.contactName;
}

/** "312-555-0142 · a.rivera@example.org"; whichever is on file when only one is. */
export function referenceReachLine(e: ReferenceEntry): string {
  return [e.phone, e.email].filter(Boolean).join(" · ");
}

/** The card's four rows, in template order. An empty relevance prints as "Comparable client". */
export function referenceCardRows(e: ReferenceEntry): [string, string][] {
  return [
    [REFERENCE_CARD_LABELS[0], e.organization],
    [REFERENCE_CARD_LABELS[1], e.relevance || "Comparable client"],
    [REFERENCE_CARD_LABELS[2], referenceContactLine(e)],
    [REFERENCE_CARD_LABELS[3], referenceReachLine(e)],
  ];
}

/** The body of the branded table that draws reference number `n` (1-based). */
export type ReferenceCardTable = Omit<
  BrandedTableBlock,
  "id" | "sectionId" | "ordinal" | "cites" | "generatedBy" | "editedByHuman"
>;

/**
 * One card as a branded-table body: the navy head row carries "Reference N"
 * (the second head cell is blank so the bar runs the full width, as in the
 * template), the label column is the table's strong first column, no caption,
 * no total row.
 */
export function referenceCardTable(e: ReferenceEntry, n: number): ReferenceCardTable {
  return {
    kind: "table",
    caption: null,
    columns: [
      { header: `Reference ${n}`, align: "left" },
      { header: "", align: "left" },
    ],
    rows: referenceCardRows(e),
    emphasizeLastRow: false,
  };
}

/** Every card of a block, numbered from 1 in stored order. */
export function referenceCardTables(entries: ReferenceEntry[]): ReferenceCardTable[] {
  return entries.map((e, i) => referenceCardTable(e, i + 1));
}

/** Every visible string of the block, for the currency screen and the gate tests. */
export function referencesBlockStrings(entries: ReferenceEntry[]): string[] {
  return referenceCardTables(entries).flatMap((t) => [
    ...t.columns.map((c) => c.header),
    ...t.rows.flat(),
  ]);
}

/* ---- the routes' wire shapes (§5.17.10) --------------------------------- */

/** GET /api/rfp/proposals/[id]/references: what is on file, ranked for this RFP. */
export type ReferenceCandidateWire = {
  id: string;
  organization: string;
  segment: string;
  relationshipSince: string | null;
  usableWithoutAsking: boolean;
  contactName: string | null;
  contactTitle: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
};
export type ReferencesGetResponse = { candidates: ReferenceCandidateWire[] };

/** POST /api/rfp/proposals/[id]/references: the answer to the references question. */
export type ReferencesPostBody = {
  /** The section holding the question, and the question's exact stored text. */
  label: string;
  question: string;
  references: ReferenceEntry[];
  /** Write the contacts back to rfp_references (update the row a
   *  `referenceId` names, create a row for a new organization). */
  keep: boolean;
  /** Edit an answer already given: the section named by `label` holds a
   *  references block and its card set is replaced in place. `question` is
   *  ignored (the question closed when it was first answered). */
  replace?: boolean;
};
export type ReferencesPostResponse = {
  /** The whole sections array after the write, like the references-gap route. */
  sections: unknown[];
  rev: number;
  /** How many rows were updated and how many created (0/0 when `keep` was false). */
  kept: number;
  created: number;
  /** A sentence for the person when something beside the answer happened
   *  (a block dropped to make room, contacts not kept). Absent otherwise. */
  note?: string;
};
