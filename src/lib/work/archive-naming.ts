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
