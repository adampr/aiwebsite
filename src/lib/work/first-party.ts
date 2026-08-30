// First-party people clearing for the disclosure checklist's personal_names
// item (§5.16, owner ruling 2026-08-29/30: two cards held on names the /work
// page itself publishes). PURE, no DB and no panel state, so
// scripts/work-tests.ts drives it directly. panel.ts calls this AFTER the
// disclosure critic answers and BEFORE the hold is composed: a finding whose
// only people are on FIRST_PARTY_PEOPLE is treated as none found, so a model
// that ignores the prompt's never-hits sentence cannot hold the card on
// XL.net's own public faces. A finding that also names anyone else still
// holds, on the remainder. The org-name adjudication path is a separate
// mechanism and is untouched by this module. NO EM DASHES in any string
// (site rule).

import { FIRST_PARTY_NAMES, FIRST_PARTY_PEOPLE } from "./config";

export interface FirstPartyClearing {
  /** Allowlisted names found in the finding, canonical allowlist spelling,
   * allowlist order. Empty means the finding was returned untouched. */
  cleared: string[];
  /** The finding with allowlisted people (and, once one was found, the
   * never-hit org names) removed and separators tidied; what a surviving
   * hold shows instead of the raw finding. */
  remainder: string;
  /** True when the card must still hold on this finding: either no
   * allowlisted name was found at all, or the remainder still carries a
   * name-shaped token (a possible OTHER person; ambiguity holds). */
  holds: boolean;
}

/** Whole-name matcher: case-insensitive, boundary-checked on both sides so
 * "Adam Radulovic" never matches inside "Adam Radulovich", flexible interior
 * whitespace. Built fresh per use (a shared /g regex would carry lastIndex
 * between calls). */
function nameRe(name: string): RegExp {
  const escaped = name
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`,
    "giu"
  );
}

/** A token that could be a personal name: starts uppercase and contains a
 * lowercase letter ("Jane", "McDonald"), which excludes role acronyms
 * ("CEO") and ordinary prose words ("introduced"). Sentence-initial
 * capitalized words DO count on purpose: the cost of that strictness is a
 * hold an admin reviews, never a name published. */
function tokenIsNameShaped(token: string): boolean {
  return /^\p{Lu}/u.test(token) && /\p{Ll}/u.test(token);
}

/** Lowercase prose the remainder check may ignore: function words, the
 * card-anatomy nouns a critic quote uses to LOCATE a hit ("in the summary"),
 * role words, and reporting verbs. CLOSED and tiny on purpose. Anything
 * lowercase outside this set holds, because the refutation round measured
 * the alternative failing open: "jdoe", "jane doe" and "jane@" are all
 * lowercase, all real disclosures, and all cleared under a
 * Titlecase-only remainder check. The cost of the strict direction is a
 * hold an admin reviews, never an identifier published. */
const GLUE_TOKENS = new Set([
  "a","an","and","also","are","as","at","body","by","caption","card","ceo",
  "chief","exec","executive","facet","footer","for","founder","from","he",
  "her","his","in","introduced","introduces","is","it","its","line","member",
  "mentioned","mentions","named","names","of","officer","on","or","own",
  "page","paragraph","president","quote","quoted","report","role","s","said",
  "says","section","sentence","she","summary","team","text","that","the",
  "their","they","title","to","was","were","with",
]);

/** Identifier-shaped residue that must hold regardless of casing: anything
 * with an @ (an address or handle), or a run of 3+ digits (phone and ticket
 * fragments). The email_addresses / phone_numbers checklist items exist,
 * but this layer must not trust the model to double-report. */
function remainderLooksIdentifier(remainder: string): boolean {
  return /@/.test(remainder) || /\d{3,}/.test(remainder);
}

function tidy(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/^[\s"'`;:,.·()[\]-]+|[\s"'`;:,.·()[\]-]+$/g, "")
    .trim();
}

/**
 * The deterministic half of the FIRST_PARTY_PEOPLE allowlist. Strips every
 * allowlisted full name from a personal_names finding; when at least one was
 * present, also strips the never-hit org names (so "introduced XL.net CEO
 * Adam Radulovic" does not survive on "XL.net") and decides whether anything
 * name-shaped remains. Rules the caller relies on:
 *
 * - A finding with NO allowlisted name is returned untouched and holds;
 *   this function never changes behavior for findings it does not clear.
 * - Matching is whole-name only. A bare first name ("Adam") is ambiguous,
 *   the credit lane already handles first names, and ambiguity holds.
 * - Residue like "CEO", "(CEO)", card-anatomy prose ("in the summary") or
 *   quote punctuation clears; a remaining name-shaped token ("Jane Doe", a
 *   lone "Jane"), ANY lowercase token outside the closed GLUE set ("jdoe",
 *   "jane doe"), an @, or a 3+ digit run holds. Fail-closed by measurement:
 *   the 2026-08-30 refutation round proved the Titlecase-only version
 *   cleared lowercase handles and addresses co-listed with an allowlisted
 *   name.
 */
export function clearFirstPartyPeople(
  finding: string,
  opts?: {
    people?: readonly { name: string; role: string }[];
    orgNames?: readonly string[];
  }
): FirstPartyClearing {
  const people = opts?.people ?? FIRST_PARTY_PEOPLE;
  const orgNames = opts?.orgNames ?? FIRST_PARTY_NAMES;
  const cleared: string[] = [];
  let rest = finding;
  for (const person of people) {
    const name = person.name.trim();
    if (!name) continue;
    if (nameRe(name).test(rest)) {
      cleared.push(person.name);
      rest = rest.replace(nameRe(name), " ");
    }
  }
  if (cleared.length === 0) {
    return { cleared, remainder: finding, holds: true };
  }
  for (const org of orgNames) {
    const name = org.trim();
    if (!name) continue;
    rest = rest.replace(nameRe(name), " ");
  }
  const remainder = tidy(rest);
  const tokens = remainder.match(/[\p{L}\p{N}'’.-]+/gu) ?? [];
  const holds =
    remainderLooksIdentifier(remainder) ||
    tokens.some(
      (t) =>
        tokenIsNameShaped(t) ||
        (/\p{Ll}/u.test(t) &&
          !/^\p{Lu}/u.test(t) &&
          (() => {
            const norm = t.replace(/^['’]+|['’.]+$/g, "").toLowerCase();
            // possessive residue ("'s" tokenized alone) normalizes to "s"
            // or to nothing at all; both are glue, not a name.
            return norm !== "" && !GLUE_TOKENS.has(norm);
          })())
    );
  return { cleared, remainder, holds };
}
