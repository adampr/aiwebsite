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
// ruling 2026-08-05). Re-examined 2026-08-25 and UPHELD. Auto-draining failed
// rows was designed and then cut: panelRunsPerSubmissionPerDay is 3 and
// claimPanel enforces it per UTC day OUTSIDE the fromHeld branch, so two
// automatic retries would consume the row's entire manual recourse and BOTH
// failure emails would then instruct a Retry that is guaranteed to be refused.
// A 300 s backoff also lands inside the same blog turn that caused the failure
// (measured hold 625 s, RuntimeMaxSec 7200), and because brain-api registers
// no disconnect handler, every dispatch abandoned at the timeout keeps
// generating and billing, so the retry would add to the contention it is
// waiting out. What replaced it is IN-RUN recovery (panel.ts: one
// byte-identical re-attach per armed stage) plus notifyPanelFailed, so the
// measured failure mode now recovers with no human and a failure that still
// lands is loud instead of silent: the operator and the submitter are both
// emailed and a reported_issues row opens, and the manual Retry lever,
// unchanged, is still the only thing that re-runs a failed row.
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
  PANEL_PASS_TAKEOVER_MS,
  QUEUE_BOOT_DELAY_MS,
  QUEUE_FAST_RETRY_MAX,
  QUEUE_FAST_RETRY_MS,
  QUEUE_TICK_MS,
  drainAction,
  workQueueDrainEnabled,
  workSubmissionsEnabled,
} from "./config";
import { queuedWorkCandidates, submissionById } from "./db";
import { kickPanel } from "./panel";
import { noteQueueWait } from "./queue-signal";

const PASS_CANDIDATES = 10;
// Keyset pages per pass: enough that ten perpetually-skipped rows at the
// queue head (a paused tenant's lane, capped rows) cannot hide every
// younger row from the drain, bounded so one pass stays finite.
const PASS_MAX_PAGES = 5;
// A pass that holds the slot this long is presumed hung (an unbounded await
// inside a run, e.g. an email send); the next tick takes over. Claim fences
// and the busy stop make an overlapping stale pass harmless. The value lives
// in config.ts as PANEL_PASS_TAKEOVER_MS so the no-DB test:work suite can pin
// it against panelWorstCaseRunMs(): with 150 s stages and a 600 s per-run
// recovery pool a HEALTHY worst-case run is about 34.75 minutes, so the old 30
// minutes would have logged an incident-shaped line on a normal path.

interface DrainState {
  timer?: ReturnType<typeof setInterval>;
  /** Token of the pass that owns the drain right now; 0 = idle. */
  passToken: number;
  passStartedAt: number;
  /** Consecutive fast re-ticks scheduled after a globally stopped pass. */
  fastRetries: number;
  /** The previous pass's stop reason, so an unchanged one logs once. */
  lastStop?: string;
}

// globalThis, not module scope (design-panel finding): instrumentation.ts is
// compiled to its own server bundle and the dev-server lifecycle can
// re-evaluate it, so a module-scope flag is not a per-process singleton.
const G = globalThis as typeof globalThis & { __workQueueDrain?: DrainState };
function state(): DrainState {
  return (G.__workQueueDrain ??= {
    passToken: 0,
    passStartedAt: 0,
    fastRetries: 0,
  });
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
    if (now - s.passStartedAt < PANEL_PASS_TAKEOVER_MS) return;
    console.log(
      `[work-drain] pass stuck past ${PANEL_PASS_TAKEOVER_MS / 60_000}m; taking over`
    );
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
          // The row is starting: clear any wait reason so a stale sentence
          // cannot outlive its cause on the submitter's next poll.
          noteQueueWait(c.id, null);
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
        // Process-local, row-keyed, 180 s TTL: this is what lets the tracker
        // say "a site update is finishing" instead of nothing at all.
        noteQueueWait(c.id, reason);
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
    const st = state();
    if (kicked > 0 || stop === "none") st.fastRetries = 0;
    else if (
      (stop === "deploy" || stop === "brain" || stop === "busy") &&
      seen > 0 &&
      st.fastRetries < QUEUE_FAST_RETRY_MAX
    ) {
      // A GLOBAL stop means every waiting row is blocked by one condition that
      // typically clears in seconds (a cutover finishing, a brain blip, the
      // one panel slot freeing). Waiting a full cadence for that is the whole
      // visible cost of Incident B: ldunn's row could not be looked at for 60 s
      // after the gate opened. One unref'd re-tick, bounded at
      // QUEUE_FAST_RETRY_MAX consecutive, closes that to 15 s; the existing
      // passToken guard makes an overlapping call a no-op.
      st.fastRetries++;
      const t = setTimeout(() => {
        void drainWorkQueue().catch((err) =>
          console.log(
            `[work-drain] fast re-tick failed: ${err instanceof Error ? err.message.slice(0, 200) : "unknown"}`
          )
        );
      }, QUEUE_FAST_RETRY_MS);
      t.unref?.();
    }
    // Log a pass whose stop reason CHANGED, or one that actually kicked. Eight
    // identical "stop=deploy" lines every two minutes is exactly the noise the
    // pm2 logrotate budget (10M/7) cannot afford.
    const changed = stop !== st.lastStop;
    st.lastStop = stop;
    if (seen === 0) return;
    if (changed || kicked > 0)
      console.log(
        `[work-drain] pass candidates=${seen} kicked=${kicked} skipped=${skipped} stop=${stop} fast=${st.fastRetries}`
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
 * There IS an early first tick now (QUEUE_BOOT_DELAY_MS, 15 s), and both
 * halves of the original (2026-08-05 ops-seat) objection are answered. The
 * first half said a boot pass "always refuses" because the deploy marker stays
 * fresh for minutes after a PM2 restart; since 2026-08-07 that is no longer
 * true, because kickPanel asks deployBlocksPanel(), which admits precisely
 * when the restart it just came through was the deploy's own cutover, so a
 * boot pass is the FIRST thing that would be allowed to run. The second half
 * was the warmup question: a boot pass races brainHealthy on a cold process,
 * and a refuse=brain STOPS the pass. With the fast re-tick (QUEUE_FAST_RETRY_MS,
 * up to QUEUE_FAST_RETRY_MAX consecutive) that objection now costs 15 s instead
 * of a full 60 s cadence, which is inside the noise of the restart itself.
 * What is left is unchanged: orphaned rows only become claimable at 240 s
 * heartbeat staleness, and the 30 s created_at age floor plus the 60 s cadence
 * reach every window within a minute of eligibility. */
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
  const tick = () => {
    drainWorkQueue().catch((err) =>
      console.log(
        `[work-drain] tick failed: ${err instanceof Error ? err.message.slice(0, 200) : "unknown"}`
      )
    );
  };
  // A cutover restarts this process, which restarts the interval at ZERO, so
  // without this a row whose gate opened during the restart could not even be
  // LOOKED at for a full cadence afterwards. That 60 s sat inside the measured
  // 3 min 23 s of dead silence on 2026-08-25.
  const boot = setTimeout(tick, QUEUE_BOOT_DELAY_MS);
  boot.unref?.();
  s.timer = setInterval(tick, QUEUE_TICK_MS);
  s.timer.unref?.();
  console.log(
    `[work-drain] started interval=${QUEUE_TICK_MS / 1000}s boot=${QUEUE_BOOT_DELAY_MS / 1000}s`
  );
}
