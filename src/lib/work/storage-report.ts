// §5.16 weekly archive-store usage report (owner directive 2026-08-19: the
// admin cleans the upload store as needed, with weekly notifications of
// usage). Composes one plain-text email from the work_archive_files ledger
// and sends it to adminRecipient() via sendGovernanceEmail, which signs at
// the seam and sends as the one persona (TRON_FROM).
//
// Scheduling mirrors queue-drain.ts discipline exactly: started from
// instrumentation.ts register(), globalThis singleton (instrumentation is
// compiled to its own bundle, so module scope is not a per-process
// singleton), supervised-checkout gate with its own FORCE override, coarse
// hourly tick. Due = now has reached the first Monday 14:00 UTC after the
// durable last-sent stamp (governance_meta, restart-proof); with no stamp at
// all (first ever run) the send happens on the first hourly check rather
// than immediately at boot, so a restart storm never fires mail in its first
// second.

import { statfsSync } from "node:fs";
import { adminRecipient, sendGovernanceEmail } from "@/lib/governance/budget";
import { getMeta, setMeta } from "@/lib/governance/db";
import {
  archiveStoreRoot,
  archiveStoreUsage,
  largestLiveArchives,
} from "./archive-store";
import {
  formatByteSize,
  nextStorageReportDueMs,
  workStorageReportEnabled,
} from "./config";
import { oneLine } from "./retention-encoding";

const TICK_MS = 3_600_000;
/** governance_meta stamp key (the notifyBudgetHit ALERT_STAMP_KEYS
 * precedent: one tiny shared table, restart-proof, no new migration). */
const STAMP_KEY = "work_storage_report_last_sent";
// Same constant notify.ts carries for every §5.16 email link.
const SITE = "https://ai.xl.net";

interface ReportState {
  timer?: ReturnType<typeof setInterval>;
  running: boolean;
}

// globalThis, not module scope (queue-drain.ts finding): instrumentation.ts
// is compiled to its own server bundle and the dev-server lifecycle can
// re-evaluate it, so a module-scope flag is not a per-process singleton.
const G = globalThis as typeof globalThis & {
  __workStorageReport?: ReportState;
};
function state(): ReportState {
  return (G.__workStorageReport ??= { running: false });
}

/** Free bytes on the filesystem holding the store, or null when statfs is
 * unavailable (root not created yet, exotic fs); the report omits the line. */
function storeFreeBytes(): number | null {
  try {
    const st = statfsSync(archiveStoreRoot());
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

/** Compose and send this week's report. Exported for the tick and for an
 * ad-hoc ops invocation; never throws (sendGovernanceEmail returns false). */
export async function sendStorageReport(): Promise<boolean> {
  const usage = await archiveStoreUsage({ windowDays: 7, fileListMax: 1 });
  const top = await largestLiveArchives(10);
  const now = Date.now();
  const lines = [
    "Weekly usage report for the /work upload storage area (accepted",
    "submission packages and retained exhibit archives on disk, one",
    "work_archive_files ledger for both).",
    "",
    `In storage now: ${usage.fileCount} file(s), ${formatByteSize(usage.totalBytes)} total.`,
    `Last 7 days: ${usage.createdInWindow} file(s) added (${formatByteSize(usage.createdBytesInWindow)}), ${usage.deletedInWindow} deleted (${formatByteSize(usage.deletedBytesInWindow)} freed).`,
  ];
  const free = storeFreeBytes();
  if (free !== null)
    lines.push(`Free space on the store's filesystem: ${formatByteSize(free)}.`);
  if (top.length > 0) {
    lines.push("", `Largest stored files (top ${top.length}):`);
    for (const f of top) {
      const ageDays = Math.max(
        0,
        Math.floor((now - f.createdAt.getTime()) / 86_400_000)
      );
      // oneLine: the title is submitter-controlled; an embedded newline
      // would otherwise forge report lines (file names are already
      // sanitizeStoredName-reduced at write time).
      lines.push(
        `- ${oneLine(f.title)} · ${f.fileName} · ${formatByteSize(f.bytes)} · ${ageDays} day(s) old`
      );
    }
  } else {
    lines.push("", "The store is empty.");
  }
  lines.push(
    "",
    `Review and clean up: ${SITE}/admin/work#storage`
  );
  return sendGovernanceEmail({
    to: adminRecipient(),
    subject: `[aiwebsite] /work upload storage: ${usage.fileCount} file(s), ${formatByteSize(usage.totalBytes)}`,
    text: lines.join("\n"),
  });
}

/** One hourly check: read the stamp, decide due-ness, claim, send. */
export async function storageReportTick(now = Date.now()): Promise<void> {
  const s = state();
  // An hourly tick overlapping a stuck send would double-claim; one in
  // flight at a time is plenty at this cadence.
  if (s.running) return;
  s.running = true;
  try {
    const stamp = await getMeta(STAMP_KEY);
    const lastSentMs = stamp ? Date.parse(stamp) : NaN;
    // Missing or unparseable stamp = first ever run: due on this first
    // check. Otherwise due at the first Monday 14:00 UTC after the stamp.
    const due = Number.isFinite(lastSentMs)
      ? now >= nextStorageReportDueMs(lastSentMs)
      : true;
    if (!due) return;
    // CLAIM BEFORE SEND, deliberately the reverse of notifyBudgetHit's
    // stamp-after-send: the stamp moves first, so a failed send logs and
    // waits for next Monday instead of retrying hourly. A lost week of
    // usage report is acceptable; an hourly email loop is not.
    await setMeta(STAMP_KEY, new Date(now).toISOString());
    const sent = await sendStorageReport();
    console.log(
      sent
        ? "[work-storage-report] sent"
        : "[work-storage-report] send FAILED; next attempt next Monday (claim-before-send)"
    );
  } catch (err) {
    console.log(
      `[work-storage-report] tick failed: ${err instanceof Error ? err.message.slice(0, 200) : "unknown"}`
    );
  } finally {
    s.running = false;
  }
}

/** Boot hook, called from instrumentation.ts register() next to
 * startWorkQueueDrain. Same gate ladder, each skip logged so a missing
 * "[work-storage-report] started" line is diagnosable from pm2 logs:
 * - NEXT_PHASE build guard (cheap insurance, as in the drain);
 * - WORK_STORAGE_REPORT_ENABLED=0 stops ONLY this email; store, intake and
 *   the /admin/work#storage console keep working;
 * - supervised-checkout gate: dev box and prod VM share one .env, so only
 *   the PM2-supervised checkout reports; WORK_STORAGE_REPORT_FORCE=1 is the
 *   deliberate override for local testing.
 * No early first tick: the first check lands up to an hour after boot,
 * which is exactly the "never at boot" contract the stamp logic assumes. */
export function startWorkStorageReport(): void {
  const env = process.env;
  const forced = env.WORK_STORAGE_REPORT_FORCE === "1";
  if (env.NEXT_PHASE === "phase-production-build") return;
  const skip = (why: string) =>
    console.log(`[work-storage-report] not started: ${why}`);
  if (!workStorageReportEnabled(env))
    return skip("WORK_STORAGE_REPORT_ENABLED=0");
  if (env.NODE_ENV === "development" && !forced)
    return skip("development server; set WORK_STORAGE_REPORT_FORCE=1 to test");
  if (process.cwd() !== "/var/www/aiwebsite" && !forced)
    return skip(
      `unsupervised checkout ${process.cwd()}; set WORK_STORAGE_REPORT_FORCE=1 to test`
    );
  const s = state();
  if (s.timer) clearInterval(s.timer);
  // The interval resets on every pm2 restart, so deploys more frequent
  // than hourly would starve the tick entirely; at real deploy cadence a
  // send slips by at most a restart's worth of hours, accepted.
  s.timer = setInterval(() => {
    storageReportTick().catch((err) =>
      console.log(
        `[work-storage-report] tick threw: ${err instanceof Error ? err.message.slice(0, 200) : "unknown"}`
      )
    );
  }, TICK_MS);
  s.timer.unref?.();
  console.log(`[work-storage-report] started interval=${TICK_MS / 1000}s`);
}
