// Workshop payment alert tests (§5.10): the pure half of the Stripe
// watcher (src/lib/workshop/stripe-alert.ts). No DB, no network, no key.
// Run: npm run test:workshopstripe
//
// Pins: which Checkout Sessions count as a workshop registration, that a
// session is alerted once (and once more when a pending bank payment
// clears), that a slow buyer whose session was OPENED before an already
// alerted one is still alerted (the reason state is an id map and not a
// time cursor), pruning, the tolerant state read, and the email text.

import assert from "node:assert/strict";
import {
  LOOKBACK_SECONDS,
  alertLines,
  alertSubject,
  alertText,
  isWorkshopSession,
  parseAlerted,
  pendingAlerts,
  pruneAlerted,
  recordAlerted,
  type WorkshopSession,
} from "../src/lib/workshop/stripe-alert";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// 2026-12-01T15:30:00Z = Tuesday, December 1, 2026, 9:30 AM CST.
const T = Date.UTC(2026, 11, 1, 15, 30) / 1000;

function session(over: Partial<WorkshopSession> = {}): WorkshopSession {
  return {
    id: "cs_live_a",
    created: T,
    status: "complete",
    payment_status: "paid",
    amount_total: 597_000,
    currency: "usd",
    metadata: { offering: "workshop-private" },
    customer_details: { name: "Pat Buyer", email: "pat@example.test" },
    line_items: {
      data: [{ description: "Private AI Builder Half-Day Workshop", quantity: 6 }],
    },
    ...over,
  };
}

test("a completed session with a workshop offering is a registration", () => {
  assert.equal(isWorkshopSession(session()), true);
  assert.equal(isWorkshopSession(session({ metadata: { offering: "workshop" } })), true);
});
test("the cohort, a session with no metadata, and another product never match", () => {
  assert.equal(isWorkshopSession(session({ metadata: { offering: "cohort" } })), false);
  assert.equal(isWorkshopSession(session({ metadata: {} })), false);
  assert.equal(isWorkshopSession(session({ metadata: null })), false);
  assert.equal(isWorkshopSession(session({ metadata: { roleplay_key: "workshop" } })), false);
});
test("an open or expired session is not a registration", () => {
  assert.equal(isWorkshopSession(session({ status: "open" })), false);
  assert.equal(isWorkshopSession(session({ status: "expired" })), false);
});

test("a new workshop session is alerted once, then never again", () => {
  const first = pendingAlerts([session()], {});
  assert.deepEqual(first.map((a) => [a.session.id, a.kind]), [["cs_live_a", "new"]]);
  const stored = recordAlerted({}, first);
  assert.deepEqual(stored, { cs_live_a: { c: T, p: "paid" } });
  assert.deepEqual(pendingAlerts([session()], stored), []);
});
test("non-workshop sessions in the same listing are ignored", () => {
  const alerts = pendingAlerts(
    [session({ id: "cs_cohort", metadata: { offering: "cohort" } }), session()],
    {}
  );
  assert.deepEqual(alerts.map((a) => a.session.id), ["cs_live_a"]);
});
test("a session opened BEFORE an already alerted one is still alerted", () => {
  // The slow buyer: opened the link first, paid last. A newest-created
  // cursor would sit at T and skip T-600.
  const stored = recordAlerted({}, pendingAlerts([session()], {}));
  const slow = session({ id: "cs_live_slow", created: T - 600 });
  assert.deepEqual(
    pendingAlerts([session(), slow], stored).map((a) => a.session.id),
    ["cs_live_slow"]
  );
});
test("several new sessions come out oldest first", () => {
  const alerts = pendingAlerts(
    [session({ id: "cs_b", created: T + 50 }), session({ id: "cs_a", created: T - 50 })],
    {}
  );
  assert.deepEqual(alerts.map((a) => a.session.id), ["cs_a", "cs_b"]);
});

test("a pending bank payment alerts once as pending and once when it clears", () => {
  const pending = session({ payment_status: "unpaid" });
  const first = pendingAlerts([pending], {});
  assert.equal(first[0].kind, "new");
  assert.match(alertLines(first[0])[3], /not cleared yet/);
  const stored = recordAlerted({}, first);
  assert.deepEqual(stored, { cs_live_a: { c: T, p: "unpaid" } });
  // Still pending: silence.
  assert.deepEqual(pendingAlerts([pending], stored), []);
  // Cleared: one follow-up, then silence again.
  const cleared = pendingAlerts([session()], stored);
  assert.deepEqual(cleared.map((a) => a.kind), ["cleared"]);
  assert.match(alertLines(cleared[0])[3], /has now cleared/);
  assert.equal(
    alertSubject(cleared),
    "[aiwebsite] Workshop payment cleared: Private AI Builder Half-Day Workshop"
  );
  assert.deepEqual(pendingAlerts([session()], recordAlerted(stored, cleared)), []);
});

test("pruning drops only entries older than the window floor", () => {
  const since = T - LOOKBACK_SECONDS;
  assert.equal(LOOKBACK_SECONDS, 15 * 86_400);
  assert.deepEqual(
    pruneAlerted(
      { old: { c: since - 1, p: "paid" }, edge: { c: since, p: "paid" }, fresh: { c: T, p: "paid" } },
      since
    ),
    { edge: { c: since, p: "paid" }, fresh: { c: T, p: "paid" } }
  );
});
test("the stored state reads tolerantly", () => {
  assert.deepEqual(parseAlerted(null), {});
  assert.deepEqual(parseAlerted(""), {});
  assert.deepEqual(parseAlerted("not json"), {});
  assert.deepEqual(parseAlerted("[1,2]"), {});
  assert.deepEqual(parseAlerted('"x"'), {});
  assert.deepEqual(
    parseAlerted('{"good":{"c":5,"p":"paid"},"bad":{"c":"5"},"null":null,"num":3}'),
    { good: { c: 5, p: "paid" } }
  );
  const map = { cs_live_a: { c: T, p: "paid" } };
  assert.deepEqual(parseAlerted(JSON.stringify(map)), map);
});

test("the email names the workshop, buyer, seats, total and Central time", () => {
  const alerts = pendingAlerts([session()], {});
  assert.deepEqual(alertLines(alerts[0]), [
    "Workshop: Private AI Builder Half-Day Workshop",
    "Buyer: Pat Buyer · pat@example.test",
    "Seats: 6 · Total: 5970.00 USD",
    "Payment: paid",
    "Checkout: cs_live_a · opened Dec 1, 2026, 9:30 AM CT",
  ]);
  assert.equal(
    alertSubject(alerts),
    "[aiwebsite] Workshop registration: Private AI Builder Half-Day Workshop"
  );
  const text = alertText(alerts);
  assert.ok(text.startsWith("A workshop registration just came in on Stripe.\n\n"));
  assert.ok(text.endsWith("Full payment details: https://dashboard.stripe.com/payments"));
  assert.ok(!text.includes("—"), "no em dash in the email");
});
test("missing buyer, line items and amount degrade to plain words", () => {
  const bare = session({ customer_details: null, line_items: null, amount_total: null });
  const [a] = pendingAlerts([bare], {});
  assert.deepEqual(alertLines(a).slice(0, 3), [
    "Workshop: Stripe workshop payment",
    "Buyer: see the Stripe dashboard",
    "Seats: unknown · Total: unknown amount",
  ]);
});
test("two payments in one tick share one email", () => {
  const alerts = pendingAlerts([session(), session({ id: "cs_live_b", created: T + 5 })], {});
  assert.equal(alertSubject(alerts), "[aiwebsite] 2 workshop payments on Stripe");
  const text = alertText(alerts);
  assert.ok(text.startsWith("2 workshop registrations came in on Stripe."));
  assert.ok(text.includes("Checkout: cs_live_a") && text.includes("Checkout: cs_live_b"));
});

console.log(`\nworkshop stripe alert tests: ${passed} passed`);
