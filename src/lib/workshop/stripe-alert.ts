// §5.10 workshop payment alerts, the pure half: which Stripe Checkout
// Sessions are workshop registrations, which of them the admin has not been
// told about yet, and what the email says. No DB, no clock read, no env:
// the IO half (stripe-watch.ts) passes everything in, and the tests
// (`npm run test:workshopstripe`, plus the list arm of `test:stripesdk`)
// drive this module directly.
//
// Why a second watcher: a private workshop (one company, never listed on
// the site or the Ticket Tailor box office) is sold through a Stripe
// Payment Link, and orders-watch.ts only sees Ticket Tailor. A session
// counts as a workshop registration when its `metadata.offering` starts
// with "workshop" (the Payment Link's metadata is copied onto every session
// it creates; a private session's link carries `workshop-private`). The
// cohort subscription (`cohort`) and the other products on the same Stripe
// account never match.

import type Stripe from "stripe";

/** How far back each tick looks, in seconds. A Checkout Session expires 24
 * hours after it is created, so a session completes within a day of its
 * `created`; fifteen days also covers a long site outage and the 2 to 14
 * days Stripe documents for a bank debit to confirm (the "pending" to
 * "paid" follow-up below). */
export const LOOKBACK_SECONDS = 15 * 86_400;

/** Pagination safety valve for one tick. */
export const MAX_SESSIONS_PER_TICK = 1_000;

/** The slice of a Checkout Session this feature reads. */
export interface WorkshopSession {
  id: string;
  created: number;
  status?: string | null;
  payment_status?: string | null;
  amount_total?: number | null;
  currency?: string | null;
  metadata?: Record<string, string> | null;
  customer_details?: { name?: string | null; email?: string | null } | null;
  line_items?: {
    data?: Array<{ description?: string | null; quantity?: number | null }>;
  } | null;
}

/** What the admin was last told about a session: its `created` (for
 * pruning) and the payment status the alert reported. */
export interface AlertedEntry {
  c: number;
  p: string;
}
export type AlertedMap = Record<string, AlertedEntry>;

/** One alert line item: the session plus whether this is the first alert
 * or the "the pending payment has now cleared" follow-up. */
export interface PendingAlert {
  session: WorkshopSession;
  kind: "new" | "cleared";
}

/** Every completed session created at or after `since` (unix seconds),
 * with its line items expanded so the seat count needs no second call.
 * Lives here, not in the IO module, so the SDK contract test can run the
 * real call against its stand-in server. */
export async function fetchCompleteSessions(
  stripe: Stripe,
  since: number
): Promise<WorkshopSession[]> {
  const out: WorkshopSession[] = [];
  for await (const s of stripe.checkout.sessions.list({
    status: "complete",
    created: { gte: since },
    limit: 100,
    expand: ["data.line_items"],
  })) {
    out.push(s as WorkshopSession);
    if (out.length >= MAX_SESSIONS_PER_TICK) break;
  }
  return out;
}

export function isWorkshopSession(s: WorkshopSession): boolean {
  const offering = s.metadata?.offering;
  return (
    s.status === "complete" &&
    typeof offering === "string" &&
    offering.startsWith("workshop")
  );
}

/** Tolerant read of the stored map: anything malformed is dropped, which
 * at worst repeats one alert (at-least-once, never a lost registration). */
export function parseAlerted(raw: string | null): AlertedMap {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: AlertedMap = {};
  for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
    const e = v as Partial<AlertedEntry> | null;
    if (e && typeof e.c === "number" && typeof e.p === "string")
      out[id] = { c: e.c, p: e.p };
  }
  return out;
}

/** Entries created before `since` can never be listed again (the fetch
 * uses the same floor), so they are dropped to keep the stored value small. */
export function pruneAlerted(alerted: AlertedMap, since: number): AlertedMap {
  const out: AlertedMap = {};
  for (const [id, e] of Object.entries(alerted)) if (e.c >= since) out[id] = e;
  return out;
}

/** The sessions the admin has not been told about, oldest first: a
 * workshop session never alerted ("new"), or one alerted while its payment
 * was still pending that Stripe now reports as paid ("cleared"). */
export function pendingAlerts(
  sessions: WorkshopSession[],
  alerted: AlertedMap
): PendingAlert[] {
  const out: PendingAlert[] = [];
  for (const session of sessions) {
    if (!isWorkshopSession(session)) continue;
    const prior = alerted[session.id];
    if (!prior) out.push({ session, kind: "new" });
    else if (prior.p !== "paid" && session.payment_status === "paid")
      out.push({ session, kind: "cleared" });
  }
  return out.sort((a, b) => a.session.created - b.session.created);
}

/** The stored map after a successful send. */
export function recordAlerted(
  alerted: AlertedMap,
  sent: PendingAlert[]
): AlertedMap {
  const out: AlertedMap = { ...alerted };
  for (const { session } of sent)
    out[session.id] = {
      c: session.created,
      p: session.payment_status ?? "unknown",
    };
  return out;
}

function workshopName(s: WorkshopSession): string {
  const names = (s.line_items?.data ?? [])
    .map((i) => i.description?.trim())
    .filter((d): d is string => Boolean(d));
  return [...new Set(names)].join(", ") || "Stripe workshop payment";
}

function seatCount(s: WorkshopSession): number | null {
  const items = s.line_items?.data ?? [];
  if (items.length === 0) return null;
  return items.reduce((sum, i) => sum + (i.quantity ?? 0), 0);
}

function paymentLine(a: PendingAlert): string {
  const status = a.session.payment_status;
  if (a.kind === "cleared")
    return "Payment: paid (the payment that was pending has now cleared)";
  if (status === "paid") return "Payment: paid";
  if (status === "unpaid")
    return "Payment: started but not cleared yet (a bank payment; a second email follows when it clears)";
  if (status === "no_payment_required") return "Payment: none required";
  return `Payment: ${status ?? "status unknown"}`;
}

/** The session's start, in the admin's timezone (owner rule: Central
 * time, never UTC). */
function centralTime(unixSeconds: number): string {
  return `${new Date(unixSeconds * 1000).toLocaleString("en-US", {
    timeZone: "America/Chicago",
    dateStyle: "medium",
    timeStyle: "short",
  })} CT`;
}

export function alertLines(a: PendingAlert): string[] {
  const s = a.session;
  const buyer =
    [s.customer_details?.name?.trim(), s.customer_details?.email?.trim()]
      .filter(Boolean)
      .join(" · ") || "see the Stripe dashboard";
  const seats = seatCount(s);
  const amount =
    typeof s.amount_total === "number"
      ? `${(s.amount_total / 100).toFixed(2)} ${(s.currency ?? "usd").toUpperCase()}`
      : "unknown amount";
  return [
    `Workshop: ${workshopName(s)}`,
    `Buyer: ${buyer}`,
    `Seats: ${seats ?? "unknown"} · Total: ${amount}`,
    paymentLine(a),
    `Checkout: ${s.id} · opened ${centralTime(s.created)}`,
  ];
}

export function alertSubject(alerts: PendingAlert[]): string {
  if (alerts.length !== 1)
    return `[aiwebsite] ${alerts.length} workshop payments on Stripe`;
  const [a] = alerts;
  return a.kind === "cleared"
    ? `[aiwebsite] Workshop payment cleared: ${workshopName(a.session)}`
    : `[aiwebsite] Workshop registration: ${workshopName(a.session)}`;
}

export function alertText(alerts: PendingAlert[]): string {
  return [
    alerts.length === 1
      ? "A workshop registration just came in on Stripe."
      : `${alerts.length} workshop registrations came in on Stripe.`,
    "",
    ...alerts.flatMap((a) => [...alertLines(a), ""]),
    "Full payment details: https://dashboard.stripe.com/payments",
  ].join("\n");
}
