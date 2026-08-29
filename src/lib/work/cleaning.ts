// The storage decision for a cleaned §5.16 submission, and the row record it
// writes (owner directive 2026-08-29: clean an upload that carries credentials
// or personal information instead of refusing it).
//
// ONE function decides what all three intake lanes persist. The lanes are
// otherwise near-identical by hand-copied convention, and the last few rounds
// of this feature were spent fixing places where one of the three had drifted;
// a rule this consequential ("never write the bytes we were told to clean")
// gets one implementation.
//
// THE CONTAINMENT RULE, and it is the whole reason this returns a nullable
// buffer: when the rebuild cannot be verified we store NO archive at all. The
// two obvious alternatives are both wrong. Falling back to the submitted bytes
// writes the exact material this round exists to remove, in three places, and
// turns a rebuilder bug into a credential at rest. Refusing the submission
// resurrects the behaviour the owner is removing, and does it on the worst
// possible trigger: the submitter did nothing wrong, our code did. So the
// submission is accepted and reviewed - the panel needs the corpus, not the
// archive bytes - and the missing retention copy is disclosed on the row and
// in the retention mail rather than being silently absent.

import type { CleaningRecord, ExtractOk } from "./extract";

/** The row record, as stored in work_submissions.cleaning_json. Paths and rule
 * ids only: a matched value never enters this object, so no disclosure
 * surface, log line or ledger row built from it can echo a credential. */
export interface StoredCleaning {
  v: 1;
  /** sha256 and length of the CLEANED archive we wrote, when we wrote one. */
  archive: { sha256: string; bytes: number } | null;
  /** Same for the standalone document slot. */
  md: { sha256: string; bytes: number } | null;
  dropped: { path: string; reason: string }[];
  redacted: string[];
  excluded: { path: string; reason: string }[];
  rules: { ruleId: string; cls: string }[];
  /** Why no archive was stored. Null on the normal cleaned path. */
  failed: string | null;
}

export interface StorageDecision {
  /** The only bytes the caller may put in archive_data and the archive store. */
  archiveData: Buffer | null;
  /** The only bytes the caller may put in md_data. */
  mdData: Buffer | null;
  /** JSON for the cleaning_json column, or null when nothing was cleaned. */
  cleaningJson: string | null;
  /** Every path the submitter should be told about, dropped and rewritten
   * alike, for the lane's disclosure copy. Empty when nothing was cleaned. */
  cleanedPaths: string[];
  /** True when the scan removed anything at all. */
  cleaned: boolean;
  /** WHAT was found, so the copy can be true. Every submitter-facing string
   * used to say "credentials" and demand rotation, which is wrong when the
   * only hit was a personal identifier: there is nothing to rotate about
   * somebody's date of birth, and telling a submitter to go rotate one is
   * both confusing and a small loss of credibility for the times it matters. */
  cleanedKind: "credential" | "personal" | "both";
  /** How many paths were cleaned in total, uncapped. `cleanedPaths` is capped
   * for display, so counting it under-reports past the cap. */
  cleanedCount: number;
  /** Set when a rebuild failed and no archive is being stored. */
  failed: string | null;
}

function mergeRules(
  records: (CleaningRecord | undefined)[]
): { ruleId: string; cls: string }[] {
  const seen = new Map<string, string>();
  for (const record of records)
    for (const rule of record?.rules ?? []) seen.set(rule.ruleId, rule.cls);
  return [...seen].map(([ruleId, cls]) => ({ ruleId, cls }));
}

/**
 * Decide what to store. `submittedArchive` is passed separately and used ONLY
 * when there is nothing to clean, which keeps the common path byte-identical
 * to its behaviour before this round: an untouched upload is stored exactly as
 * it arrived, because a rebuild is never byte-identical (jszip rewrites local
 * headers, drops extra fields and degrades mtimes to DOS granularity) and
 * there is no reason to make every clean submission pay that.
 */
export function decideStorage(opts: {
  pkg: ExtractOk;
  submittedArchive: Buffer;
  /** The standalone document slot, when the lane has one. `submitted` is used
   * only when that document needed no cleaning. */
  md?: { extract: ExtractOk; submitted: Buffer } | null;
}): StorageDecision {
  const pkgClean = opts.pkg.cleaning;
  const mdClean = opts.md?.extract.cleaning;
  if (!pkgClean && !mdClean)
    return {
      archiveData: opts.submittedArchive,
      mdData: opts.md ? opts.md.submitted : null,
      cleaningJson: null,
      cleanedPaths: [],
      cleaned: false,
      cleanedKind: "credential",
      cleanedCount: 0,
      failed: null,
    };

  const archiveData = pkgClean
    ? (pkgClean.stored?.bytes ?? null)
    : opts.submittedArchive;
  const mdData = !opts.md
    ? null
    : mdClean
      ? (mdClean.stored?.bytes ?? null)
      : opts.md.submitted;

  const record: StoredCleaning = {
    v: 1,
    archive: pkgClean?.stored
      ? { sha256: pkgClean.stored.sha256, bytes: pkgClean.stored.length }
      : null,
    md: mdClean?.stored
      ? { sha256: mdClean.stored.sha256, bytes: mdClean.stored.length }
      : null,
    dropped: [...(pkgClean?.droppedPaths ?? []), ...(mdClean?.droppedPaths ?? [])],
    redacted: [...(pkgClean?.redactedPaths ?? []), ...(mdClean?.redactedPaths ?? [])],
    excluded: [...(pkgClean?.excludedPaths ?? []), ...(mdClean?.excludedPaths ?? [])],
    rules: mergeRules([pkgClean, mdClean]),
    failed: pkgClean && !pkgClean.stored ? (pkgClean.failed ?? "rebuild failed") : null,
  };

  const classes = new Set(record.rules.map((r) => r.cls));
  return {
    archiveData,
    mdData,
    cleaningJson: JSON.stringify(record),
    cleanedPaths: cleanedPathsOf(record),
    cleaned: true,
    cleanedKind:
      classes.has("credential") && classes.has("personal")
        ? "both"
        : classes.has("personal")
          ? "personal"
          : // A filename-class drop (.env, a key file) records no rule but is
            // unambiguously a credential, so the default belongs on that side.
            "credential",
    cleanedCount: allCleanedPaths(record).length,
    failed: record.failed,
  };
}

/** Every path worth naming to a human, dropped first: a file that is gone
 * matters more to the reader than one that was patched. Capped at 20 like
 * every other path list in this feature. */
export function cleanedPathsOf(record: StoredCleaning): string[] {
  return allCleanedPaths(record).slice(0, 20);
}

/** The same list UNCAPPED, for counting. Counting the capped list is how a
 * submission that cleaned 30 files tells the submitter it cleaned 20. */
export function allCleanedPaths(record: StoredCleaning): string[] {
  return [
    ...record.dropped.map((d) => d.path),
    ...record.excluded.map((e) => e.path),
    ...record.redacted,
  ];
}

/** Read a row's cleaning_json. Total: a malformed or legacy value reads as
 * "nothing was cleaned", which is the safe direction for every consumer
 * (they render no notice rather than crashing a page or an email). */
export function parseCleaning(json: string | null | undefined): StoredCleaning | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as StoredCleaning;
    if (!parsed || typeof parsed !== "object" || parsed.v !== 1) return null;
    return {
      v: 1,
      archive: parsed.archive ?? null,
      md: parsed.md ?? null,
      dropped: Array.isArray(parsed.dropped) ? parsed.dropped : [],
      redacted: Array.isArray(parsed.redacted) ? parsed.redacted : [],
      excluded: Array.isArray(parsed.excluded) ? parsed.excluded : [],
      rules: Array.isArray(parsed.rules) ? parsed.rules : [],
      failed: parsed.failed ?? null,
    };
  } catch {
    return null;
  }
}
