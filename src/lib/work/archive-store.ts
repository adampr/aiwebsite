// On-disk archive store for §5.16 uploads (owner directive 2026-08-19:
// with the 100 MB cap the retention email can no longer carry every
// package, so the durable copy of every accepted upload lives here, in a
// storage area an admin can clean as needed).
//
// Layout: <root>/<submissionId>/<NN>-<sanitizedName>, root =
// WORK_ARCHIVE_DIR or data/work-archives under the process cwd. data/ is
// excluded from deploy rsync, so the store survives deploys on the VM; on
// the dev box it is gitignored with the rest of data/.
//
// Ledger: work_archive_files, one row per stored file, written only after
// the file is renamed into place and re-stats at the written size. The
// ledger row is the audit trail: admin cleanup deletes the FILE and stamps
// deleted_at/deleted_by; the row is never deleted, and a submission-row
// delete only SET NULLs submission_id (title/file_name are snapshots so
// the ledger keeps meaning).
//
// The DB queries live HERE, not in db.ts, deliberately: db.ts is the
// work_submissions module and this table has its own lifecycle; keeping
// them together would tangle the clearing rules. The pure name/path rules
// live in archive-naming.ts so test:work covers them without a DB.

import { createHash } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import {
  EXHIBIT_DIR,
  isExhibitSlug,
  resolveUnderStoreRoot,
  sanitizeStoredName,
  storedExhibitRelPath,
  storedRelPath,
} from "./archive-naming";

const A = schema.workArchiveFiles;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Store root. Env-overridable (WORK_ARCHIVE_DIR, .env.example); default
 * sits under data/ because deploy.sh excludes /data/ from rsync, which is
 * what makes the store durable across deploys on the VM. */
export function archiveStoreRoot(): string {
  return (
    process.env.WORK_ARCHIVE_DIR ||
    path.join(process.cwd(), "data", "work-archives")
  );
}

/** Resolve a ledger rel_path under the root, refusing anything that would
 * escape it. rel paths are minted by storedRelPath (uuid dir + sanitized
 * segment) or storedExhibitRelPath (exhibits/<slug>/ + sanitized segment),
 * so a failure here means a tampered ledger row, not user input. The rule
 * itself lives in archive-naming.ts (pure, DB-free, disk-free) so it is
 * pinnable in the unit suites; this wrapper only supplies the env root. */
function resolveUnderRoot(relPath: string): string {
  return resolveUnderStoreRoot(archiveStoreRoot(), relPath);
}

export type ArchiveFileRow = typeof A.$inferSelect;

/**
 * Persist a submission's original upload files into the store, called at
 * ACCEPT time by all three intake lanes (create route, update route, email
 * lane) right after createSubmission. NEVER throws and never fails the
 * submission: on any failure the file simply has no store copy, the bytea
 * on the row remains the copy, and the publish-time verification refuses
 * to clear it (the 2026-08-04 never-delete-the-only-copy ruling keeps
 * holding through every partial-failure shape).
 *
 * The array-position wrapper over storeArchiveFilesAt: intake always
 * passes [package, md?], so index == slot there. The backfill/import ops
 * scripts call storeArchiveFilesAt directly because they may store a
 * SUBSET (md only, or completing one missing file), and the slot must
 * come from WHICH blob a file is (package=00, md=01), never from its
 * position in a partial array.
 */
export async function storeArchiveFiles(
  submissionId: string,
  title: string,
  files: { name: string; data: Buffer }[]
): Promise<void> {
  return storeArchiveFilesAt(
    submissionId,
    title,
    files.map((f, i) => ({ slot: i, name: f.name, data: f.data }))
  );
}

/** Slot-explicit store write (see storeArchiveFiles for the contract: never
 * throws, per-file failures log and leave the bytea as the copy). */
export async function storeArchiveFilesAt(
  submissionId: string,
  title: string,
  files: { slot: number; name: string; data: Buffer }[]
): Promise<void> {
  try {
    if (!UUID_RE.test(submissionId))
      throw new Error(`not a uuid: ${submissionId}`);
    const root = path.resolve(archiveStoreRoot());
    const subDir = path.join(root, submissionId);
    await mkdir(subDir, { recursive: true });
    // Opportunistic hygiene: a crash between writeFile and rename leaves a
    // .tmp-* orphan behind; sweep any such leftovers in this submission's
    // dir before writing (best-effort, never a gate).
    try {
      for (const name of await readdir(subDir))
        if (/\.tmp-\d+-\d+$/.test(name))
          await unlink(path.join(subDir, name)).catch(() => undefined);
    } catch {
      // hygiene only
    }
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      try {
        const rel = storedRelPath(submissionId, f.slot, f.name);
        const abs = resolveUnderRoot(rel);
        const sha256 = createHash("sha256").update(f.data).digest("hex");
        // Temp-then-rename: a crash mid-write leaves a .tmp orphan, never a
        // ledgered path with partial bytes.
        const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
        await writeFile(tmp, f.data);
        await rename(tmp, abs);
        const st = await stat(abs);
        if (st.size !== f.data.length) {
          await unlink(abs).catch(() => undefined);
          throw new Error(
            `size mismatch after write: ${st.size} != ${f.data.length}`
          );
        }
        try {
          await db.insert(A).values({
            submissionId,
            title: title.slice(0, 200),
            fileName: sanitizeStoredName(f.name),
            relPath: rel,
            bytes: f.data.length,
            sha256,
          });
        } catch (err) {
          // An unledgered file is invisible to verification, usage totals
          // and admin cleanup: remove it rather than leak it (the bytea
          // remains the copy either way).
          await unlink(abs).catch(() => undefined);
          throw err;
        }
      } catch (err) {
        console.log(
          `[work] archive store failed for ${submissionId} file ${f.slot} (${f.name.slice(0, 80)}): ${err instanceof Error ? err.message.slice(0, 200) : "unknown"} (bytea remains the copy)`
        );
      }
    }
  } catch (err) {
    console.log(
      `[work] archive store failed for ${submissionId}: ${err instanceof Error ? err.message.slice(0, 200) : "unknown"} (bytea remains the copy)`
    );
  }
}

/**
 * Persist the source archive of a HAND-AUTHORED EXHIBIT card (the bays
 * 01 to 05 lane of src/app/work/page.tsx, which has no work_submissions
 * row at all) into the same store, under exhibits/<slug>/<NN>-<name>.
 *
 * The ledger row carries submissionId: null. That column is nullable and
 * already SET NULL on a submission delete, and title/file_name are
 * snapshots taken at write time, so a null-submission row keeps its full
 * meaning with NO schema change and NO migration: the store, the usage
 * rollup, the weekly report and admin cleanup all key off the ledger row,
 * never off the submission. Readers tell the two lanes apart by rel_path
 * (isExhibitRelPath), which is why nothing needed a new column.
 *
 * UNLIKE storeArchiveFiles/storeArchiveFilesAt, this THROWS on failure
 * instead of logging and continuing. The intake path swallows because the
 * submission row's bytea is still a copy of the very bytes it failed to
 * store, so a swallowed failure costs nothing but a retry (and
 * publish-time verification refuses to clear a bytea it cannot match).
 * An exhibit has NO other copy anywhere: no row, no bytea, nothing but
 * the file the operator handed over. A swallowed failure here would tell
 * an operator their archive is retained while the store holds nothing,
 * which is the one outcome this lane exists to prevent. So: same
 * temp-write -> rename -> re-stat -> ledger-insert -> unlink-on-failure
 * discipline, opposite failure contract.
 *
 * Files are slot-explicit for the same reason the ops scripts are: the
 * slot is WHICH file a thing is (00 package, 01 document), never its
 * position in a possibly partial array. Returns the ledger rows written,
 * in the order given. A throw leaves no unledgered file behind for the
 * entry that failed; entries already written keep their ledger rows, and
 * a re-run skips them (the caller's per-slot gate sees them).
 */
export async function storeExhibitArchive(
  slug: string,
  title: string,
  files: { slot: number; name: string; data: Buffer }[]
): Promise<ArchiveFileRow[]> {
  if (!isExhibitSlug(slug))
    throw new Error(`not an exhibit slug: ${JSON.stringify(slug)}`);
  const root = path.resolve(archiveStoreRoot());
  const dir = path.join(root, EXHIBIT_DIR, slug);
  await mkdir(dir, { recursive: true });
  // Same opportunistic hygiene as the submission lane: a crash between
  // writeFile and rename leaves a .tmp-* orphan; sweep this exhibit's dir
  // before writing (best-effort, never a gate).
  try {
    for (const name of await readdir(dir))
      if (/\.tmp-\d+-\d+$/.test(name))
        await unlink(path.join(dir, name)).catch(() => undefined);
  } catch {
    // hygiene only
  }
  const written: ArchiveFileRow[] = [];
  for (const f of files) {
    const rel = storedExhibitRelPath(slug, f.slot, f.name);
    const abs = resolveUnderRoot(rel);
    const sha256 = createHash("sha256").update(f.data).digest("hex");
    // Temp-then-rename: a crash mid-write leaves a .tmp orphan, never a
    // ledgered path with partial bytes.
    const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, f.data);
    await rename(tmp, abs);
    const st = await stat(abs);
    if (st.size !== f.data.length) {
      await unlink(abs).catch(() => undefined);
      throw new Error(
        `${rel}: size mismatch after write: ${st.size} != ${f.data.length}`
      );
    }
    try {
      const rows = await db
        .insert(A)
        .values({
          submissionId: null,
          title: title.slice(0, 200),
          fileName: sanitizeStoredName(f.name),
          relPath: rel,
          bytes: f.data.length,
          sha256,
        })
        .returning();
      if (!rows[0]) throw new Error("ledger insert returned no row");
      written.push(rows[0]);
    } catch (err) {
      // An unledgered file is invisible to verification, usage totals and
      // admin cleanup: remove it rather than leak it. Then rethrow: with
      // no bytea behind this lane, an unstored exhibit must be a failure
      // the operator sees, not a log line.
      await unlink(abs).catch(() => undefined);
      throw err;
    }
  }
  return written;
}

/** EVERY ledger row (admin-deleted included) under one exhibit's slug
 * directory, in stored order. The exhibit twin of
 * allArchiveFilesForSubmission, and it carries the same semantics: the
 * operator lane must SEE an admin-deleted row to disclose it, because
 * work_archive_rel_path_uq is a FULL unique index covering deleted rows,
 * so a retired slot is retired permanently.
 *
 * Prefix match rather than a column lookup, because the lane lives in the
 * rel_path and nowhere else. Safe as a LIKE: isExhibitSlug admits only
 * [a-z0-9-], so a slug can carry neither of LIKE's wildcards (% and _),
 * and the pattern is a bound parameter either way. */
export async function allArchiveFilesForExhibit(
  slug: string
): Promise<ArchiveFileRow[]> {
  if (!isExhibitSlug(slug)) return [];
  return db
    .select()
    .from(A)
    .where(sql`${A.relPath} like ${`${EXHIBIT_DIR}/${slug}/%`}`)
    .orderBy(A.relPath);
}

export async function archiveFileById(
  id: string
): Promise<ArchiveFileRow | null> {
  if (!UUID_RE.test(id)) return null;
  const rows = await db.select().from(A).where(eq(A.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Every LIVE (not admin-deleted) ledger row for a submission, in stored
 * order (rel_path carries the NN index). */
export async function archiveFilesForSubmission(
  submissionId: string
): Promise<ArchiveFileRow[]> {
  if (!UUID_RE.test(submissionId)) return [];
  return db
    .select()
    .from(A)
    .where(and(eq(A.submissionId, submissionId), isNull(A.deletedAt)))
    .orderBy(A.relPath);
}

/** EVERY ledger row for a submission, admin-deleted rows INCLUDED, in
 * stored order. The backfill/import operator scripts read this because
 * admin cleanup is FINAL for those lanes: a deleted row's rel_path is
 * permanently retired (work_archive_rel_path_uq is a FULL unique index
 * covering deleted rows, so re-filing the same slot would collide at the
 * ledger insert and unlink the fresh file anyway), and the scripts must
 * see the deleted row to disclose it instead of failing opaquely. */
export async function allArchiveFilesForSubmission(
  submissionId: string
): Promise<ArchiveFileRow[]> {
  if (!UUID_RE.test(submissionId)) return [];
  return db
    .select()
    .from(A)
    .where(eq(A.submissionId, submissionId))
    .orderBy(A.relPath);
}

/** Read one stored file's bytes by its ledger rel_path. Throws on a missing
 * file or a root escape; callers decide their own fallback. */
export async function readStoredArchive(relPath: string): Promise<Buffer> {
  return readFile(resolveUnderRoot(relPath));
}

/**
 * The submission's files out of the STORE, shaped like archiveDataById
 * (name + bytes), or null when the store cannot serve the complete set
 * (no ledger rows, an admin-deleted file, a disk miss, a size mismatch).
 * All-or-nothing on purpose: the retention email enumerates a submission's
 * files as one package, and a silently partial set would make its copy lie.
 */
export async function storedFilesForSubmission(
  submissionId: string
): Promise<{ name: string; data: Buffer }[] | null> {
  const rows = await archiveFilesForSubmission(submissionId);
  if (rows.length === 0) return null;
  const out: { name: string; data: Buffer }[] = [];
  for (const r of rows) {
    try {
      const data = await readStoredArchive(r.relPath);
      if (data.length !== r.bytes) return null;
      out.push({ name: r.fileName, data });
    } catch {
      return null;
    }
  }
  return out;
}

/** Match every expected file (the row's actual blob set) against LIVE
 * ledger rows and re-stat each on disk at the recorded size. Shared by the
 * advisory read below (stat-only: sha256 was computed at write time after
 * the rename, so for a residency LINE in an email the stat is enough) and
 * the in-transaction clear, which additionally passes each expected
 * buffer's own sha256: name + size + stat proves A file of the right
 * shape is there, only the hash equality proves it is THIS file (an
 * operator-imported wrong file of the same length would otherwise get the
 * real bytea cleared - refutation F1 of the backfill round, 2026-08-19).
 * Hashing at most 100 MB once per publish is a fine price for making
 * disk==row a proven invariant instead of an assumption. */
async function matchAndStat(
  liveRows: ArchiveFileRow[],
  expected: { name: string; bytes: number; sha256?: string }[]
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (expected.length === 0) return { ok: false, reason: "nothing expected" };
  const unclaimed = [...liveRows];
  for (const e of expected) {
    const want = sanitizeStoredName(e.name);
    const idx = unclaimed.findIndex(
      (r) => r.fileName === want && r.bytes === e.bytes
    );
    if (idx === -1)
      return { ok: false, reason: `no live ledger row for ${want} (${e.bytes} bytes)` };
    const row = unclaimed.splice(idx, 1)[0];
    if (e.sha256 !== undefined && row.sha256 !== e.sha256)
      return {
        ok: false,
        reason: `${row.relPath} ledger sha256 ${row.sha256} != row bytea sha256 ${e.sha256} (the store copy is not this file; bytea kept)`,
      };
    try {
      const st = await stat(resolveUnderRoot(row.relPath));
      if (st.size !== row.bytes)
        return {
          ok: false,
          reason: `${row.relPath} is ${st.size} bytes on disk, ledger says ${row.bytes}`,
        };
    } catch (err) {
      return {
        ok: false,
        reason: `${row.relPath} unreadable: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}`,
      };
    }
  }
  return { ok: true };
}

/**
 * ADVISORY verification (no locks): feeds the retention email's residency
 * copy only. The clearing decision never rests on this - it has a TOCTOU
 * gap against admin cleanup by construction; use verifyAndClearRowBytes
 * for anything that deletes.
 */
export async function verifyStoredCopies(
  submissionId: string,
  expected: { name: string; bytes: number }[]
): Promise<{ ok: true } | { ok: false; reason: string }> {
  return matchAndStat(await archiveFilesForSubmission(submissionId), expected);
}

/**
 * The ONE bytea-clearing primitive (notify.ts deliverArchiveRetention is
 * its only caller), ATOMIC against admin cleanup (refutation F1): one
 * transaction that locks the submission's ledger rows FOR UPDATE (the
 * reorderPublishedCard acquisition pattern), re-checks deleted_at IS NULL
 * and re-stats every expected file at its recorded size INSIDE the
 * transaction, then clears the row's archive_data/md_data in the same
 * transaction. deleteStoredArchive's stamp UPDATE serializes behind these
 * row locks, so either the delete commits first (the deleted_at re-check
 * fails here and the bytea stays) or it waits for this commit - at which
 * point removing the store file is the admin's deliberate act against a
 * row whose retention mail already went out, not a race.
 *
 * Takes the BUFFERS about to be cleared, not name/size pairs: each
 * buffer's sha256 is computed here and must EQUAL the matched ledger
 * row's stored sha256 (backfill-round refutation F1: the work:import
 * lane can, under --force, ledger a file whose bytes are not the row's,
 * and name+size+stat alone would then clear the only true copy).
 * Fail-closed: any mismatch keeps the bytea and the reason names the slot.
 */
export async function verifyAndClearRowBytes(
  submissionId: string,
  expected: { name: string; data: Buffer }[]
): Promise<{ cleared: boolean; reason?: string }> {
  if (!UUID_RE.test(submissionId))
    return { cleared: false, reason: "not a uuid" };
  if (expected.length === 0)
    return { cleared: false, reason: "nothing expected" };
  const hashed = expected.map((e) => ({
    name: e.name,
    bytes: e.data.length,
    sha256: createHash("sha256").update(e.data).digest("hex"),
  }));
  const S = schema.workSubmissions;
  return db.transaction(async (tx) => {
    const locked = await tx
      .select()
      .from(A)
      .where(eq(A.submissionId, submissionId))
      .orderBy(A.relPath)
      .for("update");
    const verdict = await matchAndStat(
      locked.filter((r) => r.deletedAt === null),
      hashed
    );
    if (!verdict.ok) return { cleared: false, reason: verdict.reason };
    await tx
      .update(S)
      .set({ archiveData: null, mdData: null, updatedAt: new Date() })
      .where(eq(S.id, submissionId));
    return { cleared: true };
  });
}

/**
 * Admin cleanup primitive (the Seat-2 console's one write): hard-delete the
 * FILE and stamp the ledger row, which stays as the audit trail. Stamps
 * FIRST (a stamped row with a lingering file is a retry; a deleted file
 * with an unstamped row is a ledger that lies), then unlinks; a missing
 * file counts as already deleted. Refuses rows already stamped.
 */
export async function deleteStoredArchive(
  id: string,
  deletedBy: string
): Promise<{ ok: true; row: ArchiveFileRow } | { ok: false; reason: string }> {
  if (!UUID_RE.test(id)) return { ok: false, reason: "not a uuid" };
  const rows = await db
    .update(A)
    .set({ deletedAt: new Date(), deletedBy: deletedBy.slice(0, 200) })
    .where(and(eq(A.id, id), isNull(A.deletedAt)))
    .returning();
  const row = rows[0];
  if (!row) return { ok: false, reason: "not found or already deleted" };
  try {
    await unlink(resolveUnderRoot(row.relPath));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      // The file is still there, so the stamp would lie (and skew the
      // usage totals): un-stamp so the row stays live and the admin can
      // simply retry the delete.
      let unstamped = true;
      try {
        await db
          .update(A)
          .set({ deletedAt: null, deletedBy: null })
          .where(eq(A.id, id));
      } catch {
        unstamped = false;
      }
      return {
        ok: false,
        reason: `unlink failed: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}${unstamped ? " (ledger row restored to live; retry the delete)" : " (WARNING: could not restore the ledger stamp; the row reads deleted while the file remains)"}`,
      };
    }
  }
  return { ok: true, row };
}

export type ArchiveStoreUsage = {
  /** Live files: ledger rows not admin-deleted. */
  fileCount: number;
  totalBytes: number;
  /** rowHasBytes: the linked submission row still holds archive_data. False
   * when the submission is gone OR its bytea was cleared after a verified
   * store copy - either way the store file is the LAST copy anywhere, and
   * the admin console must say so before a delete (refutation M1). */
  files: (ArchiveFileRow & { rowHasBytes: boolean })[];
  /** Rows written inside the window (the weekly report's added delta). */
  createdInWindow: number;
  createdBytesInWindow: number;
  /** Admin deletions inside the window (for the weekly usage email). */
  deletedInWindow: number;
  deletedBytesInWindow: number;
};

/** Usage rollup for the admin storage console and the weekly usage email
 * (Seat 2). `files` is capped newest-first; counts and byte totals are
 * whole-store aggregates regardless of the cap. */
export async function archiveStoreUsage(opts?: {
  windowDays?: number;
  fileListMax?: number;
}): Promise<ArchiveStoreUsage> {
  const windowStart = new Date(
    Date.now() - (opts?.windowDays ?? 7) * 24 * 3600 * 1000
  );
  const [liveAgg] = await db
    .select({
      n: sql<number>`count(*)::int`,
      bytes: sql<number>`coalesce(sum(${A.bytes}), 0)::bigint`,
    })
    .from(A)
    .where(isNull(A.deletedAt));
  const [deletedAgg] = await db
    .select({
      n: sql<number>`count(*)::int`,
      bytes: sql<number>`coalesce(sum(${A.bytes}), 0)::bigint`,
    })
    .from(A)
    .where(and(gte(A.deletedAt, windowStart)));
  const [createdAgg] = await db
    .select({
      n: sql<number>`count(*)::int`,
      bytes: sql<number>`coalesce(sum(${A.bytes}), 0)::bigint`,
    })
    .from(A)
    .where(gte(A.createdAt, windowStart));
  // Existence flag only - the blob column itself is never selected (the
  // ROW_COLS discipline holds even for this one-bit probe).
  const S = schema.workSubmissions;
  const joined = await db
    .select({
      row: A,
      rowHasBytes: sql<boolean>`${S.archiveData} is not null`,
    })
    .from(A)
    .leftJoin(S, eq(A.submissionId, S.id))
    .where(isNull(A.deletedAt))
    .orderBy(desc(A.createdAt))
    .limit(opts?.fileListMax ?? 500);
  const files = joined.map((j) => ({
    ...j.row,
    rowHasBytes: j.rowHasBytes === true,
  }));
  return {
    fileCount: liveAgg?.n ?? 0,
    totalBytes: Number(liveAgg?.bytes ?? 0),
    files,
    createdInWindow: createdAgg?.n ?? 0,
    createdBytesInWindow: Number(createdAgg?.bytes ?? 0),
    deletedInWindow: deletedAgg?.n ?? 0,
    deletedBytesInWindow: Number(deletedAgg?.bytes ?? 0),
  };
}

/** The N largest LIVE files (the weekly report's top-of-store list); size
 * then recency breaks ties so the order is stable across sends. */
export async function largestLiveArchives(
  limit: number
): Promise<ArchiveFileRow[]> {
  return db
    .select()
    .from(A)
    .where(isNull(A.deletedAt))
    .orderBy(desc(A.bytes), desc(A.createdAt))
    .limit(limit);
}
