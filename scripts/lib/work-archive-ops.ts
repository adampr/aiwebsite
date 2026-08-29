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

/** One advisory-lock key shared by ALL THREE ops scripts (work:backfill,
 * work:import and, since 2026-08-29, work:retain) (pg_try_advisory_lock):
 * two concurrent storeArchiveFilesAt runs against the same submission can
 * interleave rename + ledger-insert-collision + unlink so that one run
 * deletes the OTHER run's live file while both exit 0. A second script
 * instance therefore refuses to start while any backfill/import holds the
 * lock, whichever of the three it is. Session-scoped: Postgres releases it when the script's connection
 * closes at process exit. Arbitrary constant, just stable and unlikely to
 * collide with other advisory users of this database. */
export const ARCHIVE_OPS_LOCK_KEY = 815162342;

/** package = slot 00, md = slot 01, ALWAYS - derived from WHICH blob a
 * file is, never from its position in a (possibly partial) array. */
export const PACKAGE_SLOT = 0;
export const MD_SLOT = 1;
/** work:import --extra files (ASSOCIATED, not the recorded original) take
 * the lowest free slots from here up, so slots 00/01 stay reserved for
 * the two blobs the row actually records (2026-08-29 canvas recovery). */
export const EXTRA_SLOT_MIN = 2;

/** The NN slot a ledger rel_path (`<uuid>/<NN>-<name>`, see storedRelPath)
 * occupies, or null when the basename carries no two-digit prefix (a
 * ledger row storeArchiveFilesAt could not have written). */
export function ledgerSlot(relPath: string): number | null {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  const m = /^(\d{2})-/.exec(base);
  return m ? Number(m[1]) : null;
}

export type LedgerSlotFact = { relPath: string; deletedAt: Date | null };

/**
 * work:import's ledger gate, per SLOT (2026-08-29; before that ANY ledger
 * row refused the whole row). For every slot about to be written, a LIVE
 * ledger row at that slot refuses (the store already manages that file:
 * no silent double-import) and an admin-DELETED row at that slot refuses
 * too (cleanup is FINAL for the scripted lanes; work_archive_rel_path_uq
 * is a full unique index, and manual SQL is deliberately the only
 * override). Slots the import does not touch are simply left alone, so a
 * row whose only ledger row is slot 00 accepts --md. A ledger rel_path
 * with no NN- prefix cannot have come from storeArchiveFilesAt: refuse
 * loudly (tampered or hand-edited ledger), never ignore it.
 */
export function importSlotRefusal(
  ledger: LedgerSlotFact[],
  slotsToWrite: number[]
): string | null {
  const malformed = ledger.filter((l) => ledgerSlot(l.relPath) === null);
  if (malformed.length > 0)
    return (
      `ledger row(s) without a NN- slot prefix: ` +
      malformed.map((l) => l.relPath).join(", ") +
      `\nstoreArchiveFilesAt never writes such a rel_path, so this ledger looks tampered or hand-edited. ` +
      `Refusing to import anything for this row until a human inspects the ledger.`
    );
  const problems: string[] = [];
  for (const slot of [...new Set(slotsToWrite)].sort((a, b) => a - b)) {
    const at = ledger.filter((l) => ledgerSlot(l.relPath) === slot);
    const nn = String(slot).padStart(2, "0");
    const live = at.find((l) => l.deletedAt === null);
    const gone = at.find((l) => l.deletedAt !== null);
    if (live)
      problems.push(
        `slot ${nn} is held by a live ledger row ${live.relPath}: the store already manages that file; refusing to double-import it.`
      );
    else if (gone)
      problems.push(
        `slot ${nn} was ADMIN-DELETED (${gone.relPath}, ${gone.deletedAt!.toISOString().slice(0, 10)}): cleanup is final for this lane; this script will not re-file it.`
      );
  }
  return problems.length > 0 ? problems.join("\n") : null;
}

/** The lowest `count` slots >= EXTRA_SLOT_MIN that no ledger row (live OR
 * admin-deleted) occupies, ascending. Malformed rel_paths are skipped
 * here only because importSlotRefusal refuses the whole row on them. */
export function freeExtraSlots(
  ledger: LedgerSlotFact[],
  count: number
): number[] {
  const taken = new Set<number>();
  for (const l of ledger) {
    const s = ledgerSlot(l.relPath);
    if (s !== null) taken.add(s);
  }
  const out: number[] = [];
  for (let s = EXTRA_SLOT_MIN; out.length < count; s++)
    if (!taken.has(s)) out.push(s);
  return out;
}

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

/** One --extra <name>=<path>: an ASSOCIATED file (something carried
 * beside the submission that is NOT the recorded original upload), stored
 * at the next free slot >= EXTRA_SLOT_MIN under `name`. */
export type ImportExtra = { name: string; path: string };

export type ImportArgs = {
  id: string;
  /** The recovered package (slot 00); optional when --md/--extra is given. */
  file: string | null;
  /** The recovered standalone SKILL.md (slot 01). */
  md: string | null;
  /** Associated files, in argv order; never enter importShaRefusal. */
  extra: ImportExtra[];
  force: boolean;
  yes: boolean;
};

/** Why an --extra name is unusable, or null. The name is the STORED name
 * (through sanitizeStoredName), so it must be a bare filename that keeps
 * a real extension; `.b64.txt` is refused because the canvas carries
 * base64-armored .skill files and an operator must decode before
 * importing (the store must hold the artifact, not its transport). */
export function extraNameRefusal(name: string): string | null {
  if (name.length === 0) return "--extra needs a non-empty name before the =";
  if (/[\\/]/.test(name))
    return `--extra name "${name}" must be a bare filename (no / or \\)`;
  if (/\.b64\.txt$/i.test(name))
    return (
      `--extra name "${name}" is a base64-armored transport copy: decode it first ` +
      `(base64 -d) and import the decoded file under its real name`
    );
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1)
    return `--extra name "${name}" needs an extension (.skill, .md, .zip) so the stored file keeps its type`;
  const ext = name.slice(dot);
  const stored = sanitizeStoredName(name);
  if (!stored.endsWith(ext))
    return `--extra name "${name}" would store as "${stored}" and lose its extension; use a plain [A-Za-z0-9._-] name`;
  return null;
}

export type ImportParse =
  | { ok: true; args: ImportArgs }
  | { ok: false; error: string };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** work:import argv contract, pure so the refusal shapes are pinned in
 * test:work: exactly one uuid positional; at least one of
 * --file/--md/--extra, each with a value (--extra repeatable as
 * <name>=<path>, names unique after sanitizing); --force/--yes booleans;
 * anything else refused (a typo'd flag must never silently become a
 * positional). */
export function parseImportArgs(argv: string[]): ImportParse {
  let id: string | null = null;
  let file: string | null = null;
  let md: string | null = null;
  const extra: ImportExtra[] = [];
  const extraNames = new Set<string>();
  let force = false;
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") force = true;
    else if (a === "--yes") yes = true;
    else if (a === "--extra") {
      const v = argv[i + 1];
      if (!v || v.startsWith("--"))
        return { ok: false, error: "--extra needs <name>=<path>" };
      const eq = v.indexOf("=");
      if (eq === -1)
        return {
          ok: false,
          error: `--extra needs <name>=<path> (no = in "${v}")`,
        };
      const name = v.slice(0, eq);
      const path = v.slice(eq + 1);
      const bad = extraNameRefusal(name);
      if (bad) return { ok: false, error: bad };
      if (!path)
        return { ok: false, error: `--extra ${name}= needs a path after the =` };
      const stored = sanitizeStoredName(name);
      if (extraNames.has(stored))
        return {
          ok: false,
          error: `--extra name "${name}" given twice (stores as ${stored})`,
        };
      extraNames.add(stored);
      extra.push({ name, path });
      i++;
    } else if (a === "--file" || a === "--md") {
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
  if (!file && !md && extra.length === 0)
    return {
      ok: false,
      error: "at least one of --file/--md/--extra is required",
    };
  return { ok: true, args: { id, file, md, extra, force, yes } };
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
