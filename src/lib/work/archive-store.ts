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
import { sanitizeStoredName, storedRelPath } from "./archive-naming";

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
 * segment), so a failure here means a tampered ledger row, not user input. */
function resolveUnderRoot(relPath: string): string {
  const root = path.resolve(archiveStoreRoot());
  const abs = path.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + path.sep))
    throw new Error(`archive path escapes the store root: ${relPath}`);
  return abs;
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
 */
export async function storeArchiveFiles(
  submissionId: string,
  title: string,
  files: { name: string; data: Buffer }[]
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
        const rel = storedRelPath(submissionId, i, f.name);
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
          `[work] archive store failed for ${submissionId} file ${i} (${f.name.slice(0, 80)}): ${err instanceof Error ? err.message.slice(0, 200) : "unknown"} (bytea remains the copy)`
        );
      }
    }
  } catch (err) {
    console.log(
      `[work] archive store failed for ${submissionId}: ${err instanceof Error ? err.message.slice(0, 200) : "unknown"} (bytea remains the copy)`
    );
  }
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
 * ledger rows and re-stat each on disk at the recorded size. A cheap stat,
 * not a re-hash: sha256 was computed at write time after the rename, so
 * the stat proves the file is still there and whole. Shared by the
 * advisory read below and the in-transaction clear. */
async function matchAndStat(
  liveRows: ArchiveFileRow[],
  expected: { name: string; bytes: number }[]
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
 */
export async function verifyAndClearRowBytes(
  submissionId: string,
  expected: { name: string; bytes: number }[]
): Promise<{ cleared: boolean; reason?: string }> {
  if (!UUID_RE.test(submissionId))
    return { cleared: false, reason: "not a uuid" };
  if (expected.length === 0)
    return { cleared: false, reason: "nothing expected" };
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
      expected
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
