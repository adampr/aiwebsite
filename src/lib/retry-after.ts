// The ONE way this site tells someone how long a 429 lasts.
//
// The shared limiter (@aicompany/core lib/rate-limit) uses a FIXED window
// anchored at the first request in it, not a sliding one, so a refusal can be
// up to a whole window away from clearing and re-trying does not shorten it.
// Both 429 helpers used to answer "Too many requests. Give it a moment." no
// matter the window: the 2026-08-09 directory report was an admin re-clicking
// Confirm remove for ten minutes against a 3600s window with ~50 minutes still
// to run, and the governance console has 86400s windows where the same
// sentence would have been off by a day.
//
// Pure and dependency-free on purpose: src/lib/work/http.ts and
// src/lib/governance/http.ts both import it, and neither may import the other.

/** Rounded up, deliberately: a wait quoted short is the defect being fixed.
 *
 * Sub-minute waits name the SECONDS rather than falling back to "in a
 * moment". On the surface this was reported for, the window is now 60s, so a
 * vaguer phrasing would have answered the owner's complaint about "give it a
 * moment" with a near-verbatim repeat of it. "In about 40 seconds" is a
 * number you can wait out; "in a moment" is the sentence that was already
 * not believed. */
export function retryAfterPhrase(retryAfterSec: number): string {
  const sec = Math.max(1, Math.ceil(retryAfterSec));
  if (sec <= 10) return "in a few seconds";
  if (sec <= 60) {
    // Rounded UP to the next ten, so it can never understate and can never
    // read "in about 60 seconds".
    const tens = Math.ceil(sec / 10) * 10;
    return tens >= 60 ? "in about a minute" : `in about ${tens} seconds`;
  }
  const minutes = Math.ceil(sec / 60);
  if (minutes === 1) return "in about a minute";
  if (minutes < 60) return `in about ${minutes} minutes`;
  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? "in about an hour" : `in about ${hours} hours`;
}

/** The full sentence, so the two helpers cannot word it differently. */
export function rateLimitedMessage(retryAfterSec: number): string {
  return `Too many requests. Try again ${retryAfterPhrase(retryAfterSec)}.`;
}
