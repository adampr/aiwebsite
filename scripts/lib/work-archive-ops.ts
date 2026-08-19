// Pure decision + parsing helpers for the §5.16 archive backfill/import
// operator scripts (scripts/work-archive-backfill.ts, work-archive-import.ts).
// Deliberately DB-free: test:work unit-tests everything here without a
// database, and the scripts stay thin wrappers around the archive-store
// seam. The only imports are the pure name/path rules the store itself
// uses, so a plan's rel_path predictions can never drift from what
// storeArchiveFilesAt would actually mint.

import {
  sanitizeStoredName,
  storedRelPath,
} from "../../src/lib/work/archive-naming";

/** One advisory-lock key shared by BOTH ops scripts (pg_try_advisory_lock):
 * two concurrent storeArchiveFilesAt runs against the same submission can
 * interleave rename + ledger-insert-collision + unlink so that one run
 * deletes the OTHER run's live file while both exit 0. A second script
 * instance therefore refuses to start while any backfill/import holds the
 * lock. Session-scoped: Postgres releases it when the script's connection
 * closes at process exit. Arbitrary constant, just stable and unlikely to
 * collide with other advisory users of this database. */
export const ARCHIVE_OPS_LOCK_KEY = 815162342;

/** package = slot 00, md = slot 01, ALWAYS - derived from WHICH blob a
 * file is, never from its position in a (possibly partial) array. */
export const PACKAGE_SLOT = 0;
export const MD_SLOT = 1;

export type ExpectedSlotFile = {
  slot: number;
  name: string;
  /** Recorded byte count from the row (archive_bytes/md_bytes), or null on
   * a row that never stamped one; null matches on name alone. */
  bytes: number | null;
};

export type LedgerFact = {
  relPath: string;
  fileName: string;
  bytes: number;
  deleted: boolean;
};

export type SlotAction =
  /** No ledger row stands in the way: store this file. */
  | "store"
  /** A LIVE ledger row already matches this file (consuming match, so one
   * ledger row can never satisfy two expected files): nothing to do. */
  | "skip-live"
  /** The slot's minted rel_path carries an admin-DELETED ledger row.
   * Admin cleanup is FINAL for the scripted lanes: work_archive_rel_path_uq
   * is a FULL unique index, so re-filing would collide at the insert (and
   * the collision handler unlinks the fresh file). Disclosed, never
   * retried; manual SQL is the only override and is deliberately not
   * offered. */
  | "skip-deleted"
  /** A LIVE ledger row occupies the slot's rel_path but did not match this
   * file (different size): storing would collide, overwriting is not this
   * script's call. Surfaced as a failure needing a human. */
  | "conflict";

export type SlotPlan = ExpectedSlotFile & { action: SlotAction };

/**
 * Per-FILE backfill plan for one row (refutation M3: per-row all-or-nothing
 * wedged half-stored rows forever). Consuming live-match first (mirrors
 * matchAndStat: name + bytes, each ledger row claimable once), then the
 * minted rel_path decides between admin-deleted finality, a live conflict,
 * and a clean store.
 */
export function planRowBackfill(
  submissionId: string,
  expected: ExpectedSlotFile[],
  ledger: LedgerFact[]
): SlotPlan[] {
  const unclaimedLive = ledger.filter((l) => !l.deleted);
  return expected.map((e) => {
    const want = sanitizeStoredName(e.name);
    const liveIdx = unclaimedLive.findIndex(
      (l) => l.fileName === want && (e.bytes === null || l.bytes === e.bytes)
    );
    if (liveIdx >= 0) {
      unclaimedLive.splice(liveIdx, 1);
      return { ...e, action: "skip-live" as const };
    }
    const rel = storedRelPath(submissionId, e.slot, e.name);
    const atSlot = ledger.filter((l) => l.relPath === rel);
    if (atSlot.some((l) => !l.deleted)) return { ...e, action: "conflict" as const };
    if (atSlot.length > 0) return { ...e, action: "skip-deleted" as const };
    return { ...e, action: "store" as const };
  });
}

/** Classification for a row with bytes in NEITHER column. */
export type ByteLessRowClass =
  /** At least one live ledger file: the store already manages this row. */
  | "ledgered"
  /** Only admin-deleted ledger rows: the admin deliberately removed the
   * last copy; cleanup is final, nothing for the scripts to recover. */
  | "admin-cleaned"
  /** No ledger rows at all: the original exists only off-box; recover it
   * via npm run work:import. */
  | "needs-recovery";

export function byteLessRowClass(ledger: LedgerFact[]): ByteLessRowClass {
  if (ledger.some((l) => !l.deleted)) return "ledgered";
  if (ledger.length > 0) return "admin-cleaned";
  return "needs-recovery";
}

export type ImportArgs = {
  id: string;
  /** The recovered package (slot 00); optional when --md is given. */
  file: string | null;
  /** The recovered standalone SKILL.md (slot 01). */
  md: string | null;
  force: boolean;
  yes: boolean;
};

export type ImportParse =
  | { ok: true; args: ImportArgs }
  | { ok: false; error: string };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** work:import argv contract, pure so the refusal shapes are pinned in
 * test:work: exactly one uuid positional; at least one of --file/--md,
 * each with a value; --force/--yes booleans; anything else refused (a
 * typo'd flag must never silently become a positional). */
export function parseImportArgs(argv: string[]): ImportParse {
  let id: string | null = null;
  let file: string | null = null;
  let md: string | null = null;
  let force = false;
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") force = true;
    else if (a === "--yes") yes = true;
    else if (a === "--file" || a === "--md") {
      const v = argv[i + 1];
      if (!v || v.startsWith("--"))
        return { ok: false, error: `${a} needs a path` };
      if (a === "--file") {
        if (file !== null) return { ok: false, error: "--file given twice" };
        file = v;
      } else {
        if (md !== null) return { ok: false, error: "--md given twice" };
        md = v;
      }
      i++;
    } else if (a.startsWith("--"))
      return { ok: false, error: `unknown flag ${a}` };
    else if (id === null) id = a;
    else return { ok: false, error: `unexpected argument ${a}` };
  }
  if (!id || !UUID_RE.test(id))
    return { ok: false, error: "a submission uuid is required" };
  if (!file && !md)
    return { ok: false, error: "at least one of --file/--md is required" };
  return { ok: true, args: { id, file, md, force, yes } };
}

export type ImportFileCheck = {
  label: string;
  localSha256: string;
  recordedSha256: string | null;
};

/**
 * The import's sha gate, pure and settled over ALL files at once so the
 * write cannot start until every verdict is in (test:work unit-tests this
 * directly rather than pinning source text order). Returns the refusal
 * message, or null to proceed:
 *  - every recorded hash matches -> proceed;
 *  - a recorded hash mismatches -> refuse with BOTH hashes, unless --force
 *    (the caller prints the PROVENANCE UNVERIFIED warning for each
 *    mismatch it proceeds past);
 *  - no recorded hash -> proceed (the caller says so); force changes
 *    nothing here.
 */
export function importShaRefusal(
  checks: ImportFileCheck[],
  force: boolean
): string | null {
  const mismatches = checks.filter(
    (c) => c.recordedSha256 !== null && c.recordedSha256 !== c.localSha256
  );
  if (mismatches.length === 0 || force) return null;
  return mismatches
    .map(
      (c) =>
        `sha256 mismatch for ${c.label}: the local file is NOT the recorded original.\n` +
        `  local:    ${c.localSha256}\n` +
        `  recorded: ${c.recordedSha256}`
    )
    .join("\n")
    .concat(
      "\nRe-check the recovered file, or pass --force to import anyway (PROVENANCE UNVERIFIED)."
    );
}
