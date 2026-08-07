// §5.16 queue drain: the automatic consumer of queued work submissions
// (owner directive 2026-08-05: a queued review must start without a human
// click). A submission whose first kickPanel was refused (panel busy, deploy
// marker, brain blip, budget) sits at status "received", and a deploy
// restart strands an in-flight run at "running" with a stale heartbeat;
// before this module the only recovery for either was a human pressing
// Retry. The drain re-kicks both classes, oldest first, through kickPanel's
// UNCHANGED admission gates (kill switch, deploy WINDOW, brain health, both
// budget ledgers, one-panel-at-a-time serialization, per-row 3-runs/day
// claim cap), so it adds no new spend path and no new authority: a timer
// kick starts exactly the run the submitter's own Retry click would, and
// update rows still park at pending_approval for the admin's click.
// Failed rows are deliberately NOT drained (unanimous 3-seat design-panel
// ruling 2026-08-05): a full run already happened, and a deterministically
// failing row auto-retried by a timer would burn its 3 daily runs every day
// until the 30-day sweep. A failed run surfaces ONLY on the submitter
// tracking pages ("Review failed" + Retry) and /admin/work — no email, no
// reported_issues row — so the manual Retry lever, unchanged, is the whole
// contract for them.
//
// Designed by a 3-seat focused panel + counterpart refutation panel
// (state-machine/concurrency, ops/budget blast radius, surface parity).
//
// 2026-08-07: the "deploy marker" gate above became the deploy WINDOW gate
// (deployBlocksPanel / work/config.ts deployBlocksPanelRun). It is still
// kickPanel's own gate, unchanged by the drain, but it now closes only while
// the deploy owns the live tree instead of for the deploy's whole duration.
// That is what stops a queued row idling through a post-cutover tail.

import {
  drainAction,
  workQueueDrainEnabled,
  workSubmissionsEnabled,
} from "./config";
import { queuedWorkCandidates, submissionById } from "./db";
import { kickPanel } from "./panel";

const TICK_MS = 60_000;
const PASS_CANDIDATES = 10;
// Keyset pages per pass: enough that ten perpetually-skipped rows at the
// queue head (a paused tenant's lane, capped rows) cannot hide every
// younger row from the drain, bounded so one pass stays finite.
const PASS_MAX_PAGES = 5;
// A pass that holds the slot this long is presumed hung (an unbounded await
// inside a run, e.g. an email send); the next tick takes over. Claim fences
// and the busy stop make an overlapping stale pass harmless.
const PASS_TAKEOVER_MS = 30 * 60_000;

interface DrainState {
  timer?: ReturnType<typeof setInterval>;
  /** Token of the pass that owns the drain right now; 0 = idle. */
  passToken: number;
  passStartedAt: number;
}

// globalThis, not module scope (design-panel finding): instrumentation.ts is
// compiled to its own server bundle and the dev-server lifecycle can
// re-evaluate it, so a module-scope flag is not a per-process singleton.
const G = globalThis as typeof globalThis & { __workQueueDrain?: DrainState };
function state(): DrainState {
  return (G.__workQueueDrain ??= { passToken: 0, passStartedAt: 0 });
}

/** One drain pass: fetch candidates, kick each through the standard
 * admission, run winners to completion serially (the panel is one-at-a-time
 * site-wide anyway; awaiting keeps the drain a polite serial consumer
 * instead of a busy-refusal thrasher). Empty ticks are silent (pm2 logrotate
 * is 10M/7; 1440 no-op lines a day would rotate real incidents away). */
export async function drainWorkQueue(): Promise<void> {
  // Global kill switch first: no query, no log, no admission churn.
  if (!workSubmissionsEnabled(process.env)) return;
  const s = state();
  const now = Date.now();
  if (s.passToken !== 0) {
    if (now - s.passStartedAt < PASS_TAKEOVER_MS) return;
    console.log("[work-drain] pass stuck past 30m; taking over");
  }
  const token = now;
  s.passToken = token;
  s.passStartedAt = now;
  try {
    let kicked = 0;
    let skipped = 0;
    let seen = 0;
    let stop = "none";
    let cursor: Date | undefined;
    for (let page = 0; page < PASS_MAX_PAGES && stop === "none"; page++) {
      const candidates = await queuedWorkCandidates(PASS_CANDIDATES, cursor);
      if (candidates.length === 0) break;
      seen += candidates.length;
      cursor = candidates[candidates.length - 1].createdAt;
      for (const c of candidates) {
        // A takeover happened mid-await: the new pass owns the queue now.
        if (state().passToken !== token) return;
        const from = c.status === "received" ? "received" : "stale-running";
        let outcome: Awaited<ReturnType<typeof kickPanel>>;
        try {
          outcome = await kickPanel(c.id);
        } catch (err) {
          console.log(
            `[work-drain] kick threw id=${c.id}: ${err instanceof Error ? err.message.slice(0, 200) : "unknown"}`
          );
          skipped++;
          continue;
        }
        if (outcome.run) {
          console.log(`[work-drain] kick id=${c.id} from=${from}`);
          kicked++;
          await outcome.run(); // runPanel never throws
          const after = await submissionById(c.id).catch(() => null);
          console.log(
            `[work-drain] done id=${c.id} status=${after?.status ?? "unknown"}`
          );
          continue;
        }
        const reason =
          outcome.outcome.status === "refused"
            ? outcome.outcome.reason
            : "claim";
        const action = drainAction(reason, c.companyId !== null);
        console.log(
          `[work-drain] refuse id=${c.id} reason=${reason} action=${action}`
        );
        if (action === "stop") {
          stop = reason;
          break;
        }
        skipped++;
      }
      // A short page means the queue is exhausted; only a FULL page earns
      // the next keyset fetch (kicked rows leave the candidate set by
      // status, so the cursor never re-reads them).
      if (candidates.length < PASS_CANDIDATES) break;
    }
    if (seen === 0) return;
    console.log(
      `[work-drain] pass candidates=${seen} kicked=${kicked} skipped=${skipped} stop=${stop}`
    );
  } finally {
    const s2 = state();
    if (s2.passToken === token) {
      s2.passToken = 0;
      s2.passStartedAt = 0;
    }
  }
}

/** Boot hook, called from instrumentation.ts register(). The gates, in
 * order, each with a logged reason so a missing "[work-drain] started" line
 * is diagnosable from pm2 logs:
 * - NEXT_PHASE build guard: redundant today (Next's own instrumentation
 *   loader skips register() during `next build`, verified against the
 *   installed 16.2.11) but cheap insurance against a version change.
 * - WORK_QUEUE_DRAIN_ENABLED=0: stops ONLY the automation; intake and the
 *   manual Retry lever keep working (WORK_SUBMISSIONS_ENABLED=0 is the
 *   bigger hammer that stops both).
 * - Supervised-checkout gate: dev box and prod VM share one .env (deploy
 *   pushes it verbatim), so an env default cannot keep a forgotten ad-hoc
 *   `next start` on a test port from becoming an unattended spend engine.
 *   Only the PM2-supervised checkout (cwd /var/www/aiwebsite, the
 *   ecosystem.config.cjs APP_ROOT) drains; WORK_QUEUE_DRAIN_FORCE=1 is the
 *   deliberate override for local testing.
 * There is still deliberately NO early first tick, but HALF of the original
 * (2026-08-05 ops-seat) rationale has expired and the comment must not be
 * read as it was written. It said a boot pass "always refuses" because the
 * deploy marker stays fresh for minutes after a PM2 restart. Since
 * 2026-08-07 that is no longer true: kickPanel asks deployBlocksPanel(),
 * which admits precisely when the restart it just came through was the
 * deploy's own cutover, so a boot pass is now the FIRST thing that would be
 * allowed to run. What still holds is the other half: orphaned rows only
 * become claimable at 240 s heartbeat staleness, and the 30 s created_at age
 * floor plus the 60 s cadence reach every window within a minute of
 * eligibility. An early tick is therefore defensible now where it was not
 * before, but it is a separate change with its own warmup questions (a boot
 * pass races brainHealthy on a cold process, and a refuse=brain STOPS the
 * pass); do not add one without deciding those. */
export function startWorkQueueDrain(): void {
  const env = process.env;
  const forced = env.WORK_QUEUE_DRAIN_FORCE === "1";
  if (env.NEXT_PHASE === "phase-production-build") return;
  const skip = (why: string) =>
    console.log(`[work-drain] not started: ${why}`);
  if (!workQueueDrainEnabled(env))
    return skip("WORK_QUEUE_DRAIN_ENABLED=0");
  if (env.NODE_ENV === "development" && !forced)
    return skip("development server; set WORK_QUEUE_DRAIN_FORCE=1 to test");
  if (process.cwd() !== "/var/www/aiwebsite" && !forced)
    return skip(
      `unsupervised checkout ${process.cwd()}; set WORK_QUEUE_DRAIN_FORCE=1 to test`
    );
  const s = state();
  if (s.timer) clearInterval(s.timer);
  s.timer = setInterval(() => {
    drainWorkQueue().catch((err) =>
      console.log(
        `[work-drain] tick failed: ${err instanceof Error ? err.message.slice(0, 200) : "unknown"}`
      )
    );
  }, TICK_MS);
  s.timer.unref?.();
  console.log(`[work-drain] started interval=${TICK_MS / 1000}s`);
}
