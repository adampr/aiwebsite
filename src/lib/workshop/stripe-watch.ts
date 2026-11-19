// §5.10 workshop payment alerts, the IO half (owner decision 2026-11-16:
// a private workshop sold through a Stripe Payment Link must email the
// admin when it is paid, the way a Ticket Tailor registration already
// does). orders-watch.ts cannot see these: the checkout happens on Stripe
// and the site has no Stripe webhook. So this is its twin, a poller on the
// same 5-minute beat: it lists the completed Checkout Sessions of the last
// LOOKBACK_SECONDS, keeps the workshop ones (stripe-alert.ts decides
// which), and mails `adminRecipient()` ONE email covering every session it
// has not been told about yet, via sendGovernanceEmail.
//
// State is a governance_meta key holding the alerted session ids, not a
// time cursor. A session's only timestamp is `created` (when the buyer
// OPENED the link), and a session opened earlier can complete later than
// one opened after it, so a "newest created" cursor would skip the slow
// buyer. The id map is pruned to the look-back window every tick, and is
// written only after a successful send: a failed send retries the whole
// batch next tick (at-least-once, like orders-watch.ts).
//
// No first-run initialization: the first tick alerts whatever workshop
// payment the window already holds, which is the wanted behaviour when the
// feature ships after a link has been handed out.
//
// Gates and switches are the registration-alert feature's own, shared with
// orders-watch.ts: WORKSHOP_ORDER_ALERTS_ENABLED=0 stops both emails,
// WORKSHOP_ORDER_ALERTS_FORCE=1 lets both run on a dev or unsupervised
// checkout. The key gate here is STRIPE_SECRET_KEY.

import Stripe from "stripe";
import { adminRecipient, sendGovernanceEmail } from "@/lib/governance/budget";
import { getMeta, setMeta } from "@/lib/governance/db";
import {
  LOOKBACK_SECONDS,
  alertSubject,
  alertText,
  fetchCompleteSessions,
  parseAlerted,
  pendingAlerts,
  pruneAlerted,
  recordAlerted,
} from "./stripe-alert";

const TICK_MS = 300_000;
const STATE_KEY = "workshop_stripe_alerted";

interface WatchState {
  timer?: ReturnType<typeof setInterval>;
  running: boolean;
}

// globalThis, not module scope: instrumentation.ts compiles to its own
// server bundle, so module scope is not a singleton (queue-drain.ts).
const G = globalThis as typeof globalThis & {
  __workshopStripeAlerts?: WatchState;
};
function state(): WatchState {
  return (G.__workshopStripeAlerts ??= { running: false });
}

/** One poll. Exported for the interval and for ad-hoc ops/testing. */
export async function workshopStripeTick(): Promise<void> {
  const s = state();
  if (s.running) return;
  s.running = true;
  try {
    const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
    if (!secretKey) return;
    const since = Math.floor(Date.now() / 1000) - LOOKBACK_SECONDS;
    const stripe = new Stripe(secretKey, {
      timeout: 15_000,
      maxNetworkRetries: 1,
    });
    const sessions = await fetchCompleteSessions(stripe, since);
    const stored = await getMeta(STATE_KEY);
    const alerted = pruneAlerted(parseAlerted(stored), since);
    const alerts = pendingAlerts(sessions, alerted);
    if (alerts.length === 0) {
      // Keep the stored value pruned even on a quiet tick, but only when
      // pruning actually dropped something (no write every 5 minutes).
      const pruned = JSON.stringify(alerted);
      if (stored && pruned !== stored) await setMeta(STATE_KEY, pruned);
      return;
    }
    const sent = await sendGovernanceEmail({
      to: adminRecipient(),
      subject: alertSubject(alerts),
      text: alertText(alerts),
    });
    if (!sent) {
      // State untouched: the whole batch retries next tick.
      console.log(
        `[workshop-stripe] send FAILED for ${alerts.length} payment(s); will retry next tick`
      );
      return;
    }
    await setMeta(STATE_KEY, JSON.stringify(recordAlerted(alerted, alerts)));
    console.log(`[workshop-stripe] alerted ${alerts.length} payment(s)`);
  } catch (err) {
    console.log(
      `[workshop-stripe] tick failed: ${err instanceof Error ? err.message.slice(0, 200) : "unknown"}`
    );
  } finally {
    s.running = false;
  }
}

/** Boot hook, called from instrumentation.ts register() right after
 * startWorkshopOrderAlerts(). The same gate ladder, each skip logged so a
 * missing "[workshop-stripe] started" line is diagnosable from pm2 logs. */
export function startWorkshopStripeAlerts(): void {
  const env = process.env;
  const forced = env.WORKSHOP_ORDER_ALERTS_FORCE === "1";
  if (env.NEXT_PHASE === "phase-production-build") return;
  const skip = (why: string) =>
    console.log(`[workshop-stripe] not started: ${why}`);
  if (env.WORKSHOP_ORDER_ALERTS_ENABLED === "0")
    return skip("WORKSHOP_ORDER_ALERTS_ENABLED=0");
  if (!env.STRIPE_SECRET_KEY?.trim()) return skip("STRIPE_SECRET_KEY unset");
  if (env.NODE_ENV === "development" && !forced)
    return skip("development server; set WORKSHOP_ORDER_ALERTS_FORCE=1 to test");
  if (process.cwd() !== "/var/www/aiwebsite" && !forced)
    return skip(
      `unsupervised checkout ${process.cwd()}; set WORKSHOP_ORDER_ALERTS_FORCE=1 to test`
    );
  const s = state();
  if (s.timer) clearInterval(s.timer);
  s.timer = setInterval(() => {
    workshopStripeTick().catch((err) =>
      console.log(
        `[workshop-stripe] tick threw: ${err instanceof Error ? err.message.slice(0, 200) : "unknown"}`
      )
    );
  }, TICK_MS);
  s.timer.unref?.();
  console.log(`[workshop-stripe] started interval=${TICK_MS / 1000}s`);
}
