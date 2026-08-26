// §5.10 AI Builders Workshop: the ONE source of truth for the next session.
// /builders (the card) and /builders/notify (the list's copy) both read from
// here so a date change is a one-file edit (the sitemap lastmod is typed). Pure module:
// no imports, no clock read (callers pass `now`), safe in server components
// and in the tsx test runner alike.
//
// Session times are 8:00 AM Central, which in September/August is CDT
// (UTC-5), so both instants are 13:00 UTC. Never write "CST" in copy: the
// owner's rule is "CT".

/** Short date label used in badges and the CTA ("Reserve September 24"). */
export const WORKSHOP_SESSION_LABEL = "September 24";
/** Long label for the session line on the card. */
export const WORKSHOP_SESSION_LONG_LABEL = "Thursday, September 24";
/** 2026-09-24T13:00:00Z = Thursday, September 24, 2026, 8:00 AM CDT. */
export const WORKSHOP_SESSION_STARTS = Date.parse("2026-09-24T13:00:00Z");
/** The previous (sold-out) session: 2026-08-27T13:00:00Z, 8:00 AM CDT. */
export const PREVIOUS_SESSION_STARTS = Date.parse("2026-08-27T13:00:00Z");
/** The previous session's label, shown as "sold out" until it starts. */
export const PREVIOUS_SESSION_LABEL = "August 27";

/** Seats are sold on Ticket Tailor (single seat pool with the email-invite
 * audience; the July 30 session oversold because site/Stripe and Ticket
 * Tailor were two pools). This is the public event page and the ONLY place
 * the URL lives in src/. */
export const WORKSHOP_TICKETS_URL =
  "https://www.tickettailor.com/events/xlnet/2382023";

/** One-time price per seat, USD. */
export const WORKSHOP_PRICE_USD = 995;
/** Hard cap per session. */
export const WORKSHOP_SEAT_CAP = 8;

/**
 * The three time windows the workshop card renders, so the page never
 * advertises a past event:
 * - "prev-sold-out": before the August 27 session starts. That session is
 *   shown sold out above the bookable September 24 one.
 * - "booking": from the August 27 start until the September 24 start. Only
 *   the September 24 session, booking open.
 * - "tba": from the September 24 start on. "Next date: TBA", no booking.
 */
export type WorkshopWindow = "prev-sold-out" | "booking" | "tba";

/** Pure: same `now` (ms since epoch) always yields the same window. The
 * boundaries are half-open on the start instant: at exactly 13:00Z a
 * session has started, so the window moves on. */
export function workshopWindow(now: number): WorkshopWindow {
  if (now < PREVIOUS_SESSION_STARTS) return "prev-sold-out";
  if (now < WORKSHOP_SESSION_STARTS) return "booking";
  return "tba";
}
