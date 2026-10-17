/**
 * Supporting-document requests, as the gate and the Attachments pane read them (§5.17.23, round 35).
 *
 * A requirement of kind "attachment" is the client asking for a document ("provide your SOC 2
 * report"). The proposal answers it on the Supporting Documents sheet, one row per request: the
 * attachment that carries it ("Attachment N - <title>") or "Not included". The row comes from the
 * Attachments pane's per-requirement mapping, stored in rfp_proposals.attachments_json as
 * `map: { "<requirementId>": n | 0 | {ns: [n...], section?: "<label>"} }` beside the numbered
 * `picks` (the object form, round 35 fix X1: several picks and/or the section of the response
 * that answers the request; the legacy n | 0 values read forever).
 *
 * This module is the ONE reader of that mapping for rule D10 (rules-d.ts) and for the pane's inline
 * gate state, so the warning a person sees beside the selector is the finding the gate stores, word
 * for word. CLIENT-SAFE by contract, like matrix.ts and unlike the rules files: pure, no imports, no
 * lookbehind. Every reader is total over hostile stored shapes: it degrades, it never throws.
 *
 * What counts:
 *   - "mapped": the stored value names at least one current pick's number, or a section of the
 *     response (the object form's `section`). A number no pick carries (a stale map entry) is NOT
 *     mapped: the sheet could not print it, so a value with nothing else reads as unanswered.
 *   - "excluded": the stored value is 0. A person decided the document is not sent; the sheet prints
 *     "Not included" and the rule stays silent.
 *   - "unmapped": anything else, including no entry at all (the default).
 */

/** The rule id the gate registers for an unanswered mandatory document request. */
export const ATTACHMENT_GAP_RULE = "D10";

/** The stored attachments state as this module reads it: loosely, never trusted as typed. */
export type AttachmentStateLike =
  | {
      picks?: unknown;
      map?: unknown;
    }
  | null
  | undefined;

/** The requirement fields this module reads. */
export type AttachmentRequirementLike = {
  id: string;
  structureLabel: string;
  text: string;
  kind: string;
  mandatory: boolean;
};

/** Where one requirement's document stands. */
export type AttachmentMapping =
  | { state: "mapped"; ns: number[]; section: string | null }
  | { state: "excluded" }
  | { state: "unmapped" };

/** The pick numbers in force (positive integers, as stored). */
function pickNumbers(state: AttachmentStateLike): Set<number> {
  const out = new Set<number>();
  const picks = state && typeof state === "object" ? state.picks : null;
  if (!Array.isArray(picks)) return out;
  for (const p of picks) {
    const n = p && typeof p === "object" ? (p as { n?: unknown }).n : undefined;
    if (typeof n === "number" && Number.isInteger(n) && n > 0) out.add(n);
  }
  return out;
}

/** The stored map entry for one requirement id, own keys only. */
function mapValue(state: AttachmentStateLike, requirementId: string): unknown {
  const map = state && typeof state === "object" ? state.map : null;
  if (!map || typeof map !== "object" || Array.isArray(map)) return undefined;
  // The stored reader (attachments.ts readProposalAttachments) lowercases
  // uuid keys; a requirement id is a Postgres uuid, so both spellings agree.
  for (const key of [requirementId, requirementId.toLowerCase()])
    if (Object.prototype.hasOwnProperty.call(map, key)) return (map as Record<string, unknown>)[key];
  return undefined;
}

/** True for a requirement that asks the client's question in document form. */
export function isAttachmentRequirement(r: { kind?: unknown } | null | undefined): boolean {
  return !!r && r.kind === "attachment";
}

/** Where one requirement's document stands under the stored state. */
export function attachmentMapping(requirementId: string, state: AttachmentStateLike): AttachmentMapping {
  const v = mapValue(state, requirementId);
  if (v === 0) return { state: "excluded" };
  const picked = pickNumbers(state);
  if (typeof v === "number") return picked.has(v) ? { state: "mapped", ns: [v], section: null } : { state: "unmapped" };
  if (!v || typeof v !== "object" || Array.isArray(v)) return { state: "unmapped" };
  let ns: number[] = [];
  let section: string | null = null;
  try {
    const o = v as { ns?: unknown; section?: unknown };
    ns = Array.isArray(o.ns)
      ? [...new Set(o.ns.filter((n): n is number => typeof n === "number" && picked.has(n)))].sort((a, b) => a - b)
      : [];
    section = typeof o.section === "string" && o.section.trim() ? o.section.trim() : null;
  } catch {
    return { state: "unmapped" };
  }
  return ns.length || section ? { state: "mapped", ns, section } : { state: "unmapped" };
}

/**
 * The mandatory document requests with no document mapped and no explicit "Not included": rule
 * D10's findings, in requirement order. A non-mandatory request left unmapped is not a finding
 * (the sheet still lists it honestly; nothing the client required is missing).
 */
export function attachmentGaps<R extends AttachmentRequirementLike>(
  requirements: readonly R[] | null | undefined,
  state: AttachmentStateLike
): R[] {
  const list = Array.isArray(requirements) ? requirements : [];
  const out: R[] = [];
  for (const r of list) {
    if (!r || typeof r !== "object" || typeof r.id !== "string") continue;
    if (!isAttachmentRequirement(r) || r.mandatory !== true) continue;
    if (attachmentMapping(r.id, state).state === "unmapped") out.push(r);
  }
  return out;
}

/** The request's words for a message: one line, no em dash, capped. The text is the client's
 *  verbatim requirement; a message renders it as a text node only. */
export function requestShown(text: unknown, cap = 90): string {
  const one = String(typeof text === "string" ? text : "")
    .replace(/\s+/g, " ")
    .replace(/—/g, "-")
    .trim();
  return one.length > cap ? `${one.slice(0, cap).trimEnd()}…` : one;
}

/** Rule D10's message for one request, and the pane's inline warning beside its selector. */
export function attachmentGapMessage(r: { structureLabel?: unknown; text?: unknown }): string {
  const label = requestShown(r.structureLabel, 24);
  return `The client requires a supporting document that nothing answers yet${label ? ` (section ${label})` : ""}: "${requestShown(r.text)}". Map it to an attachment in the Attachments pane, or mark it Not included.`;
}

/* ---- Citation tokens on the page (round 35 fix T1/T3) ---------------------------------------- */

/** The rule ids: an unresolved citation token that reached a printed string (BLOCK), and a
 *  citation the resolver stripped because it pointed at no pick (WARN). */
export const ATT_TOKEN_LEFT_RULE = "D11";
export const ATT_CITATION_STRIPPED_RULE = "D12";

/** Any spelling of a citation token's opening: what D11 refuses in resolved text. After the
 *  renderer's resolver (furniture.ts resolveAttTokens) no printed string can match it. */
export const ATT_TOKEN_LEFT = /\{\{\s*att/i;

/** D11's message. */
export const ATT_TOKEN_LEFT_MESSAGE =
  "An attachment citation reached the page without being resolved. This is a fault in how the response is put together, not in the wording; report it before sending.";

/** D12's message for one section (or the cover letter): how many citations the renderer left
 *  out because they pointed at no picked attachment. */
export function attCitationStrippedMessage(where: { label: string; letter: boolean }, count: number): string {
  const place = where.letter ? "The cover letter" : `Section ${requestShown(where.label, 24)}`;
  return `${place}: ${count === 1 ? "an attachment citation pointed" : `${count} attachment citations pointed`} at nothing, so ${count === 1 ? "it was" : "they were"} left out of the page. Read the sentence${count === 1 ? "" : "s"} around ${count === 1 ? "it" : "them"}: attach the document ${count === 1 ? "it" : "each"} meant and redraft the section, or edit the wording.`;
}
