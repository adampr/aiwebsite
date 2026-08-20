// §5.10 workshop registration alerts (owner directive 2026-08-20: when
// someone registers for an AI Builder workshop, an email goes to
// adam@xl.net). Registrations happen entirely on Ticket Tailor — the site
// never sees the checkout, and Ticket Tailor's API exposes neither webhook
// management nor order-notification settings (dashboard-only) — so this is
// a poller: every 5 minutes it asks the Ticket Tailor orders API for
// orders newer than a durable cursor and mails `adminRecipient()`
// (ADMIN_EMAIL first entry, default adam@xl.net) one email listing the new
// registration(s) via sendGovernanceEmail (signed, TRON_FROM persona).
//
// Scheduling mirrors storage-report.ts / queue-drain.ts discipline:
// started from instrumentation.ts register(), globalThis singleton,
// NEXT_PHASE build guard, kill switch, supervised-checkout gate with a
// FORCE override for local testing, every skip logged.
//
// Cursor mechanics (governance_meta key, restart-proof, no migration):
// the stamp is the created_at (unix seconds) of the newest alerted order.
// First ever run initializes the cursor to the newest EXISTING order and
// sends nothing — the feature alerts on registrations from install time
// forward, never backfills months of old orders into email. A tick that
// finds new orders sends ONE email covering all of them and advances the
// stamp only when the send succeeded, so a Resend failure retries the
// whole batch next tick (at-least-once; a duplicate alert is acceptable,
// a lost registration alert is not — the deliberate inverse of the
// storage report's claim-before-send, whose risk profile is reversed).
//
// PII note: the ops API key returns buyer fields masked ("****") unless
// the key has "include personal data" enabled, so the email degrades to
// "see the Ticket Tailor dashboard" for buyer identity when masked.

import { adminRecipient, sendGovernanceEmail } from "@/lib/governance/budget";
import { getMeta, setMeta } from "@/lib/governance/db";

const TICK_MS = 300_000;
const STAMP_KEY = "workshop_order_alert_cursor";
const API_BASE = "https://api.tickettailor.com";
/** Pagination safety valve: 10 pages × 100 orders per tick is far beyond
 * any real registration burst; deeper backlogs drain across ticks. */
const MAX_PAGES = 10;

interface TicketTailorOrder {
  id: string;
  created_at: number;
  status?: string;
  total?: number;
  currency?: { code?: string };
  buyer_details?: { name?: string | null; email?: string | null };
  event_summary?: { name?: string; start_date?: { formatted?: string } };
  issued_tickets?: Array<{ description?: string | null }>;
}

interface WatchState {
  timer?: ReturnType<typeof setInterval>;
  running: boolean;
}

// globalThis, not module scope (queue-drain.ts finding): instrumentation.ts
// compiles to its own server bundle, so module scope is not a singleton.
const G = globalThis as typeof globalThis & {
  __workshopOrderAlerts?: WatchState;
};
function state(): WatchState {
  return (G.__workshopOrderAlerts ??= { running: false });
}

/** All orders with created_at strictly after `cursor`, ascending (the API's
 * natural order). Throws on any non-OK page so a flaky tick retries whole. */
async function fetchOrdersAfter(
  cursor: number,
  apiKey: string
): Promise<TicketTailorOrder[]> {
  const auth = `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
  const orders: TicketTailorOrder[] = [];
  let url = `${API_BASE}/v1/orders?limit=100&created_at.gt=${cursor}`;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(url, {
      headers: { authorization: auth, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok)
      throw new Error(`Ticket Tailor orders fetch failed: ${res.status}`);
    const body = (await res.json()) as {
      data?: TicketTailorOrder[];
      links?: { next?: string | null };
    };
    orders.push(...(body.data ?? []));
    const next = body.links?.next;
    if (!next) break;
    url = next.startsWith("http") ? next : `${API_BASE}${next}`;
  }
  return orders;
}

/** Ticket Tailor masks buyer PII as "****" for keys without the
 * include-personal-data grant; treat masked/empty as unknown. */
function pii(value: string | null | undefined): string | null {
  const v = value?.trim();
  return v && v !== "****" ? v : null;
}

function orderLines(order: TicketTailorOrder): string[] {
  const tickets = order.issued_tickets ?? [];
  const buyer =
    [pii(order.buyer_details?.name), pii(order.buyer_details?.email)]
      .filter(Boolean)
      .join(" · ") || "see the Ticket Tailor dashboard (masked for this API key)";
  const amount =
    typeof order.total === "number"
      ? `${(order.total / 100).toFixed(2)} ${(order.currency?.code ?? "usd").toUpperCase()}`
      : "unknown amount";
  const lines = [
    `Event: ${order.event_summary?.name ?? "unknown event"}`,
    `Starts: ${order.event_summary?.start_date?.formatted ?? "unknown"}`,
    `Buyer: ${buyer}`,
    `Tickets: ${tickets.length || "unknown"} · Total: ${amount}`,
    `Order: ${order.id} (${order.status ?? "status unknown"}) · placed ${new Date(order.created_at * 1000).toUTCString()}`,
  ];
  const descriptions = [
    ...new Set(tickets.map((t) => t.description?.trim()).filter(Boolean)),
  ];
  if (descriptions.length > 0)
    lines.splice(4, 0, `Ticket type(s): ${descriptions.join(", ")}`);
  return lines;
}

/** One poll: read the cursor, fetch newer orders, mail the admin, advance.
 * Exported for the interval and for ad-hoc ops/testing invocation. */
export async function workshopOrdersTick(): Promise<void> {
  const s = state();
  if (s.running) return;
  s.running = true;
  try {
    const apiKey = process.env.TICKETTAILOR_API_KEY?.trim();
    if (!apiKey) return;
    const stamp = await getMeta(STAMP_KEY);
    const cursor = stamp ? Number.parseInt(stamp, 10) : NaN;
    if (!Number.isFinite(cursor)) {
      // First ever run: alert from now on, never backfill history.
      const existing = await fetchOrdersAfter(0, apiKey);
      const newest = existing.reduce(
        (max, o) => Math.max(max, o.created_at || 0),
        Math.floor(Date.now() / 1000)
      );
      await setMeta(STAMP_KEY, String(newest));
      console.log(
        `[workshop-orders] cursor initialized at ${newest} (${existing.length} historical order(s) skipped)`
      );
      return;
    }
    const orders = await fetchOrdersAfter(cursor, apiKey);
    if (orders.length === 0) return;
    const eventNames = [
      ...new Set(orders.map((o) => o.event_summary?.name).filter(Boolean)),
    ];
    const subject =
      orders.length === 1
        ? `[aiwebsite] Workshop registration: ${eventNames[0] ?? "Ticket Tailor order"}`
        : `[aiwebsite] ${orders.length} workshop registrations`;
    const text = [
      orders.length === 1
        ? "A new workshop registration just came in on Ticket Tailor."
        : `${orders.length} new workshop registrations came in on Ticket Tailor.`,
      "",
      ...orders.flatMap((o) => [...orderLines(o), ""]),
      "Full order details: https://www.tickettailor.com/ (box office dashboard).",
    ].join("\n");
    const sent = await sendGovernanceEmail({
      to: adminRecipient(),
      subject,
      text,
    });
    if (!sent) {
      // Stamp untouched: the whole batch retries next tick (at-least-once).
      console.log(
        `[workshop-orders] send FAILED for ${orders.length} order(s); will retry next tick`
      );
      return;
    }
    const newest = orders.reduce((max, o) => Math.max(max, o.created_at), cursor);
    await setMeta(STAMP_KEY, String(newest));
    console.log(
      `[workshop-orders] alerted ${orders.length} order(s), cursor -> ${newest}`
    );
  } catch (err) {
    console.log(
      `[workshop-orders] tick failed: ${err instanceof Error ? err.message.slice(0, 200) : "unknown"}`
    );
  } finally {
    s.running = false;
  }
}

/** Boot hook, called from instrumentation.ts register() next to the other
 * timers. Same gate ladder, each skip logged so a missing
 * "[workshop-orders] started" line is diagnosable from pm2 logs:
 * - NEXT_PHASE build guard;
 * - WORKSHOP_ORDER_ALERTS_ENABLED=0 stops ONLY this alert email;
 * - TICKETTAILOR_API_KEY unset: nothing to poll with (the tick also
 *   re-checks, so a key added without restart just starts working);
 * - supervised-checkout gate: dev box and prod VM share one .env, so only
 *   the PM2-supervised checkout polls; WORKSHOP_ORDER_ALERTS_FORCE=1 is
 *   the deliberate override for local testing. */
export function startWorkshopOrderAlerts(): void {
  const env = process.env;
  const forced = env.WORKSHOP_ORDER_ALERTS_FORCE === "1";
  if (env.NEXT_PHASE === "phase-production-build") return;
  const skip = (why: string) =>
    console.log(`[workshop-orders] not started: ${why}`);
  if (env.WORKSHOP_ORDER_ALERTS_ENABLED === "0")
    return skip("WORKSHOP_ORDER_ALERTS_ENABLED=0");
  if (!env.TICKETTAILOR_API_KEY?.trim())
    return skip("TICKETTAILOR_API_KEY unset");
  if (env.NODE_ENV === "development" && !forced)
    return skip("development server; set WORKSHOP_ORDER_ALERTS_FORCE=1 to test");
  if (process.cwd() !== "/var/www/aiwebsite" && !forced)
    return skip(
      `unsupervised checkout ${process.cwd()}; set WORKSHOP_ORDER_ALERTS_FORCE=1 to test`
    );
  const s = state();
  if (s.timer) clearInterval(s.timer);
  s.timer = setInterval(() => {
    workshopOrdersTick().catch((err) =>
      console.log(
        `[workshop-orders] tick threw: ${err instanceof Error ? err.message.slice(0, 200) : "unknown"}`
      )
    );
  }, TICK_MS);
  s.timer.unref?.();
  console.log(`[workshop-orders] started interval=${TICK_MS / 1000}s`);
}
