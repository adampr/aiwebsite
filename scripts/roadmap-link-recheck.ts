// Nightly re-check for the §5.20 evidence ladder.
//
// WHY THIS EXISTS: before it, "confirmed" meant "confirmed once". A field
// that reached its target in August still read as current in December,
// because the Retry control disappeared the moment a field went green and
// nothing else ever looked at it again. This job is the other half of the
// promise: what counts stays true, or stops counting.
//
// WHY IT IS A TIMER AND NOT AN INTERVAL IN THE WEB PROCESS: the cadence is
// daily, so an in-process setInterval would spend the whole day asleep
// holding a timer in the request server for one burst of work. The
// governance job next door already established the pattern (host-owned
// deploy/post-install.sh installs the unit), and systemd brings three
// things the interval cannot: an OnFailure alert unit, Persistent catch-up
// after a reboot, and isolation from a PM2 reload that would otherwise
// abandon a half-finished run.
//
// WHAT IT WILL NOT DO:
//  - never edits a URL, never deletes a row, never attests anything. It
//    only re-runs the same check a human could run from the page.
//  - never touches an "attested" field. That is a person's claim; a clock
//    does not falsify it, and re-probing an address we already know we
//    cannot reach from here would just burn requests to prove it again.
//  - never un-lights a step on its own. It records a failure; the grace
//    window in fieldCounts decides when that failure stops counting, so a
//    single bad minute on a customer's server costs nothing.

import "dotenv/config";
import { ROADMAP_CAPS, STAFF_LANE_DOMAIN, roadmapEnabled } from "@/lib/roadmap/config";
import { deployInProgress } from "@/lib/governance/db";
import { linksDueForRecheck, recordLinkCheck } from "@/lib/roadmap/db";
import { checkUrlReachable } from "@/lib/roadmap/url-check";

function log(msg: string): void {
  console.log(`${new Date().toISOString()} roadmap-link-recheck: ${msg}`);
}

async function main(): Promise<void> {
  // Same self-gate as the governance job: a first-deploy timer fire must
  // not race db:migrate or the PM2 cutover.
  if (deployInProgress()) {
    log("deploy in progress, skipping");
    return;
  }
  if (!roadmapEnabled(process.env)) {
    log("ROADMAP_ENABLED=0, skipping");
    return;
  }

  const due = await linksDueForRecheck({
    reachedAfterHours: ROADMAP_CAPS.recheckReachedAfterHours,
    internalAfterHours: ROADMAP_CAPS.recheckInternalAfterHours,
    // A failing field is retried daily so it can recover on its own well
    // inside the grace window, which is the difference between a blip that
    // heals itself and a support ticket.
    failedAfterHours: 24,
    // Over-select, then apply per-lane fairness below. One lane can hold
    // toolsMax (100) tools x 2 fields plus the singletons, which is more
    // than a whole batch: without fairness a single large tenant would
    // occupy every run and nobody else would ever be re-checked.
    limit: ROADMAP_CAPS.recheckBatchMax * 4,
    staffDomain: STAFF_LANE_DOMAIN,
  });

  if (!due.length) {
    log("nothing due");
    return;
  }
  const perLane = new Map<string, number>();
  const batch: typeof due = [];
  for (const c of due) {
    if (batch.length >= ROADMAP_CAPS.recheckBatchMax) break;
    const lane = c.companyId ?? "staff";
    const used = perLane.get(lane) ?? 0;
    if (used >= ROADMAP_CAPS.recheckPerLaneMax) continue;
    perLane.set(lane, used + 1);
    batch.push(c);
  }
  // Whatever is skipped is simply the stalest next run: selection is
  // oldest-checked-first, so nothing can be starved forever.
  log(
    `${due.length} due, checking ${batch.length} across ${perLane.size} lane(s) (batch cap ${ROADMAP_CAPS.recheckBatchMax}, per-lane cap ${ROADMAP_CAPS.recheckPerLaneMax})`
  );

  // WALL-CLOCK BUDGET. The loop is sequential and each field can spend up
  // to the checker's 12s plus DNS, so a batch of unresponsive hosts could
  // run past the unit's TimeoutStartSec and be SIGTERMed, which pages as a
  // failure for what is really just a slow night. Stopping early is fine:
  // selection is oldest-first, so whatever is skipped leads tomorrow.
  const deadline = Date.now() + ROADMAP_CAPS.recheckRunBudgetMinutes * 60_000;
  let ranOut = false;

  let reached = 0;
  let internal = 0;
  let failed = 0;
  let dropped = 0;

  // SEQUENTIAL on purpose. Concurrency here would buy minutes on a job with
  // all night to run, and would turn a shared host (several tenants behind
  // the same vendor) into a burst of simultaneous requests from our address.
  for (const c of batch) {
    if (Date.now() > deadline) {
      ranOut = true;
      break;
    }
    let outcome;
    try {
      outcome = await checkUrlReachable(c.url, {
        internalDomain: c.internalDomain,
      });
    } catch {
      // checkUrlReachable is written not to throw; if it ever does, skip
      // the row rather than let one bad host end the whole run.
      continue;
    }
    const state = outcome.ok
      ? outcome.evidence === "internal"
        ? "internal"
        : "ok"
      : "failed";

    // The lane comes from the row we just read, so the write is bound to the
    // same tenant it was selected from, and recordLinkCheck additionally
    // binds it to the exact URL probed: if an admin edited the address while
    // this run was in flight, the verdict lands on nothing rather than on a
    // value we never looked at.
    const updated = await recordLinkCheck({
      scope: { companyId: c.companyId },
      id: c.id,
      field: c.field,
      probedUrl: c.url,
      state,
      reason: outcome.ok ? null : outcome.reason,
      httpStatus: outcome.status,
      // Second half of the compare-and-swap. The batch was selected
      // minutes ago and deliberately excluded attested fields; without
      // this an admin who attested in the meantime would have their claim
      // overwritten by a probe that was always going to fail.
      expectState: c.state,
    });
    if (!updated) {
      dropped++;
      continue;
    }
    if (state === "ok") reached++;
    else if (state === "internal") internal++;
    else failed++;
  }

  log(
    `done: ${reached} reached, ${internal} internal, ${failed} failing, ${dropped} moved underneath us${ranOut ? " (stopped on the run budget; the rest lead tomorrow)" : ""}`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
