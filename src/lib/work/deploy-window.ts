// §5.16 deploy-window admission for panel runs (2026-08-07).
//
// The impure half of the rule documented on deployBlocksPanelRun() in
// config.ts: read the deploy marker, ask when this process started, and let
// the pure predicate decide. A leaf module on purpose - config.ts is
// client-safe (constants only, no node imports) and must stay importable by
// the browser bundle, while governance/db.ts, which owns deployInProgress()
// for the governance lanes, pulls the Postgres client. Keeping the fs read
// here lets test:work drive the real decision without either dependency.
//
// The marker PATH is duplicated from governance/db.ts by necessity (importing
// it would drag the DB client into every caller); the TTL copy lives next to
// the predicate in config.ts. test:work source-scrapes governance/db.ts and
// fails loudly if either drifts.
//
// PROCESS-LIFETIME PREMISE: this is only meaningful inside the long-lived
// PM2 server, whose start time is the cutover's restart. A short-lived script
// process always starts after the last marker touch, so the gap bound in
// deployBlocksPanelRun is the only thing keeping the gate shut for it (a
// script launched more than CUTOVER_RESTART_MAX_GAP_MS after a phase touch
// blocks correctly; one launched inside that window would not). Script
// callers of kickPanel must therefore keep their own deployInProgress()
// preflight - scripts/work-panel-rerun.ts:160 does, deliberately.

import fs from "node:fs";
import { deployBlocksPanelRun } from "./config";

/** Same file governance/db.ts deployInProgress() stats. */
export const DEPLOY_MARKER_PATH = "/var/run/aiwebsite-deploy-in-progress";

/** Marker mtime in ms, or null when there is no marker (the normal state,
 * and always the case on a dev box). Never throws: any stat failure -
 * absent, permission, an unreadable /var/run - reads as "no deploy", which
 * is what this gate believed before it could see phases at all. */
function markerTouchedAtMs(markerPath: string): number | null {
  try {
    return fs.statSync(markerPath).mtimeMs;
  } catch {
    return null;
  }
}

/** Wall-clock ms at which this process was FORKED, from the kernel rather
 * than from Node.
 *
 * `Date.now() - process.uptime()*1000` is the obvious answer and it is
 * systematically WRONG in the dangerous direction: uptime's clock starts
 * after fork+exec+V8 init, so it reports the process as having started
 * ~709 ms later than it did (measured on this box against the values below).
 * The refutation panel showed what that costs. A pm2 autorestart landing up
 * to 709 ms BEFORE a marker touch would compute a POSITIVE distance from
 * that touch, clear the "started at or before the touch" test, sit inside
 * the cutover gap, and open the gate for a whole staged build. A bias that
 * only ever pushes toward admitting cannot be absorbed by "ties block".
 *
 * /proc/self/stat field 22 is the process's start time in clock ticks since
 * boot, and /proc/stat's btime is the boot instant, so together they give
 * the true fork time. USER_HZ is 100 on Linux; rather than trust that
 * blindly, the result is cross-checked against the uptime figure and
 * discarded if they disagree by more than a minute, which is what a wrong
 * HZ or an exotic /proc would look like. Non-Linux and unreadable /proc
 * fall back to the uptime figure, whose sub-second permissive bias is
 * survivable: the worst case is a run started during a build that the flip
 * then kills, which lands in the stale-running class the drain recovers. */
function processStartedAtMs(nowMs: number): number {
  const fromUptime = nowMs - process.uptime() * 1000;
  try {
    const stat = fs.readFileSync("/proc/self/stat", "utf8");
    // Skip pid and the parenthesised comm, which can itself contain spaces.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const startTicks = Number(fields[19]);
    const btime = /^btime (\d+)$/m.exec(fs.readFileSync("/proc/stat", "utf8"));
    if (btime && Number.isFinite(startTicks)) {
      const fromProc = (Number(btime[1]) + startTicks / 100) * 1000;
      if (Math.abs(fromProc - fromUptime) < 60_000) return fromProc;
    }
  } catch {
    // not Linux, or /proc is not readable in this sandbox
  }
  return fromUptime;
}

/** True when kickPanel should refuse with reason "deploy": a deploy is live
 * AND its cutover has not restarted this process. Returns false once that
 * restart is behind us, so the minutes of post-cutover deploy work (timers,
 * seeds, crawl, watchdog, stamp) no longer idle the queue.
 *
 * One clock read feeds both derived values, so the two comparisons inside
 * the predicate always see a single consistent instant.
 *
 * `markerPath` and `env` exist ONLY so test:work can drive this against a
 * temp marker and exercise the real statSync/uptime/argument-order path;
 * production always takes the defaults. Without that seam the impure half
 * had no coverage at all, and swapping the last two arguments (both
 * `number`, so the compiler is blind) passed the whole suite. */
export function deployBlocksPanel(opts?: {
  strict?: boolean;
  markerPath?: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const now = Date.now();
  // Incident lever (review panel): one env flip plus
  // `pm2 restart aiwebsite --update-env` restores the pre-2026-08-07
  // refuse-for-the-whole-deploy behaviour, without WORK_SUBMISSIONS_ENABLED=0
  // stopping intake outright or WORK_QUEUE_DRAIN_ENABLED=0 leaving the intake
  // kicks admitting. Documented in .env.example next to the other WORK_ keys.
  const strict =
    opts?.strict === true ||
    (opts?.env ?? process.env).WORK_DEPLOY_GATE_STRICT === "1";
  // strict = the pre-2026-08-07 rule, "refuse for the whole deploy". Infinity
  // makes the pure predicate see a process that started after every possible
  // touch, so only the marker's presence and its TTL decide. The admin
  // re-run lane (kickPanel fromHeld) keeps it: a fromHeld claim moves the row
  // held -> running WITHOUT clearing held_at (db.ts claimPanel), and
  // queuedWorkCandidates skips held_at IS NOT NULL rows on purpose, so a
  // re-run the cutover kills is stranded at running+held_at with no recovery
  // - the drain will not touch it and the re-run route 409s anything that is
  // not held/pending_approval. Widening that lane into a deploy buys a human
  // nothing: they can click again in a minute.
  return deployBlocksPanelRun(
    markerTouchedAtMs(opts?.markerPath ?? DEPLOY_MARKER_PATH),
    strict ? Number.POSITIVE_INFINITY : processStartedAtMs(now),
    now
  );
}
