// Workshop session window tests (§5.10): the pure `workshopWindow` clock
// function behind /builders and /builders/notify. No DB, no network.
// Run: npm run test:workshop
//
// The three boundaries are pinned AT the instant (a session that has
// started is no longer advertised) and one millisecond either side, so a
// future date change cannot silently flip a half-open boundary.

import assert from "node:assert/strict";
import {
  PREVIOUS_SESSION_LABEL,
  PREVIOUS_SESSION_STARTS,
  WORKSHOP_PRICE_USD,
  WORKSHOP_SEAT_CAP,
  WORKSHOP_SESSION_LABEL,
  WORKSHOP_SESSION_LONG_LABEL,
  WORKSHOP_SESSION_STARTS,
  WORKSHOP_TICKETS_URL,
  workshopWindow,
} from "../src/lib/workshop/session";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// The instants themselves, as unix ms, so a typo in the ISO strings fails
// here rather than on the live card.
test("August 27 session starts 2026-08-27T13:00:00Z (8:00 AM CDT)", () => {
  assert.equal(PREVIOUS_SESSION_STARTS, 1787835600000);
});
test("September 24 session starts 2026-09-24T13:00:00Z (8:00 AM CDT)", () => {
  assert.equal(WORKSHOP_SESSION_STARTS, 1790254800000);
  assert.ok(WORKSHOP_SESSION_STARTS > PREVIOUS_SESSION_STARTS);
});

test("before the August 27 start: prev-sold-out", () => {
  assert.equal(workshopWindow(0), "prev-sold-out");
  assert.equal(workshopWindow(Date.parse("2026-08-26T12:00:00Z")), "prev-sold-out");
  assert.equal(workshopWindow(PREVIOUS_SESSION_STARTS - 1), "prev-sold-out");
});
test("exactly at the August 27 start: booking", () => {
  assert.equal(workshopWindow(PREVIOUS_SESSION_STARTS), "booking");
  assert.equal(workshopWindow(PREVIOUS_SESSION_STARTS + 1), "booking");
});
test("between the sessions: booking", () => {
  assert.equal(workshopWindow(Date.parse("2026-09-10T00:00:00Z")), "booking");
  assert.equal(workshopWindow(WORKSHOP_SESSION_STARTS - 1), "booking");
});
test("exactly at the September 24 start: tba", () => {
  assert.equal(workshopWindow(WORKSHOP_SESSION_STARTS), "tba");
  assert.equal(workshopWindow(WORKSHOP_SESSION_STARTS + 1), "tba");
});
test("long after: tba", () => {
  assert.equal(workshopWindow(Date.parse("2027-01-01T00:00:00Z")), "tba");
});

test("labels and commercial constants", () => {
  assert.equal(WORKSHOP_SESSION_LABEL, "September 24");
  assert.equal(WORKSHOP_SESSION_LONG_LABEL, "Thursday, September 24");
  assert.equal(WORKSHOP_PRICE_USD, 995);
  assert.equal(WORKSHOP_SEAT_CAP, 8);
  assert.equal(
    WORKSHOP_TICKETS_URL,
    "https://www.tickettailor.com/events/xlnet/2382023",
  );
});

// The labels are derived from the instants, so editing one without the
// other fails here instead of on the live card.
function chicagoLabel(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    timeZone: "America/Chicago",
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
test("labels agree with the instants in Central time", () => {
  assert.equal(
    chicagoLabel(WORKSHOP_SESSION_STARTS),
    `${WORKSHOP_SESSION_LONG_LABEL} at 8:00 AM`,
  );
  assert.ok(WORKSHOP_SESSION_LONG_LABEL.endsWith(WORKSHOP_SESSION_LABEL));
  assert.equal(
    chicagoLabel(PREVIOUS_SESSION_STARTS),
    `Thursday, ${PREVIOUS_SESSION_LABEL} at 8:00 AM`,
  );
});

console.log(`workshop-session: ${passed} tests passed`);
