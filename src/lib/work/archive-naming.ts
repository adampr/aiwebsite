// Pure path/name helpers for the §5.16 on-disk archive store
// (archive-store.ts). Split from the store the way email-parse.ts is split
// from email-intake.ts: this module touches no DB and no filesystem, so
// scripts/work-tests.ts (tsx, no DB) can pin every rule.
//
// Upload filenames are submitter-controlled (web upload name, email MIME
// filename) and reach this seam raw. The stored name must be safe as a
// single path segment under the store root: no separators, no control
// characters, never hidden or option-like, never a traversal component.
// The NN index prefix in the rel path makes two same-named files in one
// submission collision-proof without inventing names.
//
// The EXHIBIT lane (2026-08-29) lives here too. /work renders TWO lanes:
// work_submissions rows ("From the Team") and the hand-authored exhibit
// cards of src/app/work/page.tsx (bays 01 to 05), which have no row and
// therefore no <submissionId> directory to store under. Their packages
// file under `exhibits/<slug>/<NN>-<name>` instead, where <slug> comes
// from the exhibit's EXACT card title. That prefix can never collide with
// a submission directory (those are DB-minted uuids, and "exhibits" is
// not one), which is what lets one ledger and one store root carry both
// lanes with no schema change.

import path from "node:path";

/** Reduce a submitter-controlled filename to one safe path segment.
 * Backslashes and slashes collapse (a path arriving as a name keeps only a
 * trace of its last segments, never its structure), control chars and
 * anything outside [A-Za-z0-9._-] collapse to "_", leading dots/dashes are
 * stripped so the result is never hidden or option-like, and "."/".."
 * can never survive (they reduce to empty, which falls back). */
export function sanitizeStoredName(name: string): string {
  const safe = name
    .replace(/[\\/]+/g, "_")
    .replace(/[\u0000-\u001f\u007f]+/g, "_")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._-]+/, "")
    .slice(0, 150);
  return safe || "upload";
}

/** Path of one stored file relative to the store root:
 * <submissionId>/<NN>-<sanitizedName>. The caller guarantees submissionId
 * is a DB-minted uuid (archive-store re-asserts it); index is the file's
 * position in the submission's file list (0 = package, 1 = SKILL.md). */
export function storedRelPath(
  submissionId: string,
  index: number,
  name: string
): string {
  const nn = String(Math.max(0, Math.floor(index))).padStart(2, "0");
  return `${submissionId}/${nn}-${sanitizeStoredName(name)}`;
}

// ---- Exhibit lane (2026-08-29) ----

/** The one directory under the store root that holds exhibit archives.
 * Everything else at that level is a submission uuid. */
export const EXHIBIT_DIR = "exhibits";

/** Bound on a slug, so a long marketing title cannot mint an unwieldy
 * directory name (or bump into a filesystem's per-component limit). */
export const EXHIBIT_SLUG_MAX = 64;

/** The exact shape exhibitSlug produces, and the ONLY shape
 * storedExhibitRelPath accepts: lowercase alphanumeric runs joined by
 * single hyphens. No dots, no separators, no leading or trailing hyphen,
 * so "." and ".." are unrepresentable and a slug is always exactly one
 * safe path segment. */
const EXHIBIT_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type ExhibitSlugResult =
  | { ok: true; slug: string }
  | { ok: false; reason: string };

/**
 * Directory slug for one exhibit, derived from its EXACT card title.
 *
 * Combining marks are folded away first (NFKD, then the mark range is
 * dropped) so an accented title keeps its letters instead of losing them
 * to the "_" that sanitizeStoredName would leave; everything outside
 * [a-z0-9] then collapses to a single hyphen, and leading/trailing
 * hyphens are trimmed.
 *
 * A title that reduces to nothing (all punctuation, an emoji-only name, a
 * CJK title with no ASCII in it) REFUSES rather than falling back to some
 * invented name. A silent fallback here would be the worst outcome the
 * lane has: two different exhibits could reduce to the same fallback and
 * their packages would then share a directory, one quietly overwriting
 * the other's slot. The caller is an operator at a terminal, so a refusal
 * costs one message and a chosen name; a collision costs an archive.
 */
export function exhibitSlug(title: string): ExhibitSlugResult {
  const folded = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const slug = folded
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, EXHIBIT_SLUG_MAX)
    .replace(/-+$/, "");
  if (slug === "")
    return {
      ok: false,
      reason: `the title ${JSON.stringify(title.slice(0, 80))} reduces to no [a-z0-9] characters, so it has no directory slug. Refusing rather than inventing one: pick an exhibit whose title carries ASCII letters or digits, or add the slug by hand after deciding what it should be.`,
    };
  return { ok: true, slug };
}

/** True for a string exhibitSlug could have produced. */
export function isExhibitSlug(value: string): boolean {
  return value.length <= EXHIBIT_SLUG_MAX && EXHIBIT_SLUG_RE.test(value);
}

/** Path of one stored exhibit file relative to the store root:
 * exhibits/<slug>/<NN>-<sanitizedName>. The slug must already be an
 * exhibitSlug result (a caller that hands over anything else has a bug,
 * not bad user input, so this throws instead of coercing); index is the
 * file's slot (0 = package, 1 = document), matching storedRelPath. */
export function storedExhibitRelPath(
  slug: string,
  index: number,
  name: string
): string {
  if (!isExhibitSlug(slug))
    throw new Error(`not an exhibit slug: ${JSON.stringify(slug)}`);
  if (!Number.isFinite(index))
    throw new Error(`exhibit slot is not a finite number: ${index}`);
  const nn = String(Math.max(0, Math.floor(index))).padStart(2, "0");
  return `${EXHIBIT_DIR}/${slug}/${nn}-${sanitizeStoredName(name)}`;
}

/** True for a ledger rel_path minted by storedExhibitRelPath. The ledger
 * carries no lane column and needs none: submission rel_paths start with a
 * uuid directory, exhibit ones with EXHIBIT_DIR, and the two sets are
 * disjoint. Readers use this to label a null-submission row as an EXHIBIT
 * archive instead of an orphaned submission file. */
export function isExhibitRelPath(relPath: string): boolean {
  return relPath.startsWith(`${EXHIBIT_DIR}/`);
}

/** Resolve a rel_path under a store root, refusing anything that would
 * escape it. Extracted from archive-store's resolveUnderRoot (whose only
 * addition is reading the root from the environment) so the escape rule
 * itself is pinnable without a DB or a disk: both lanes' rel paths must
 * stay under the root, and the exhibit lane adds the first non-uuid
 * directory component the store has ever had. */
export function resolveUnderStoreRoot(root: string, relPath: string): string {
  const base = path.resolve(root);
  const abs = path.resolve(base, relPath);
  if (abs !== base && !abs.startsWith(base + path.sep))
    throw new Error(`archive path escapes the store root: ${relPath}`);
  return abs;
}
