// Timestamp formatting for /rfp (§5.17).
//
// Relative under a week, absolute beyond it. A date on a row that never
// changes trains people to stop reading dates, so this is used only where
// freshness is the question being asked.

// No pinned zone: in client components this is the VIEWER's timezone.
// Server components must not use these for absolute times — they format in
// the VM's zone; use <LocalTime> (src/components/local-time.tsx) instead.
//
// Hour + minute + timeZoneName, never a bare date. A bare date carries a
// zone it never names, so a row idle 8+ days silently renders the VM's UTC
// day and a reader west of Greenwich sees this evening's work dated
// tomorrow with nothing on screen admitting a zone was involved.
//
// This formatter backs TWO lanes, not three: when()'s >7-day branch and
// exact(). <LocalTime withTime> emits the same token, but it does NOT
// import this one - src/components/local-time.tsx imports only React and
// builds its own two formatters inline (a UTC-pinned seed, and the
// post-mount one). The three lanes agree because the option sets MATCH,
// which is a weaker guarantee than one shared formatter and fails
// silently: change the token here (drop timeZoneName, month "short" ->
// "long") and you move when() and exact() while every <LocalTime> surface
// keeps the old shape, with nothing in tsc or the four suites to say so.
// <LocalTime> is the larger half of the site. Edit both, in lockstep.
const ABS_TIME = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZoneName: "short",
});

// Zone-pinned formatters, built once per zone. <When> needs a PINNED render
// for its seed (see src/components/when.tsx): if the seed and the post-mount
// value are the same string, React's eager-state bailout drops the update and
// the DOM keeps whatever the server wrote, forever. Pinning the seed to UTC
// makes the two values genuinely differ for any viewer who is not on UTC, so
// the commit actually happens.
const PINNED = new Map<string, Intl.DateTimeFormat>();
function absIn(tz: string): Intl.DateTimeFormat {
  let f = PINNED.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
      timeZone: tz,
    });
    PINNED.set(tz, f);
  }
  return f;
}

/**
 * Relative under 7 days, absolute beyond it.
 *
 * `tz` pins the ABSOLUTE branch to a named zone (an IANA name, or "UTC").
 * Omit it and the absolute branch formats in the runtime's own zone, which
 * is the VM's UTC on a server render and the viewer's zone in the browser.
 * The relative branch is zone-free either way, so `tz` does not touch it:
 * "3 hours ago" is the same sentence in every zone, and rewriting it as an
 * absolute time would trade a freshness signal for a lookup.
 */
export function when(d: Date | string | null, tz?: string): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  const ms = Date.now() - date.getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) {
    const m = Math.round(ms / 60_000);
    return `${m} minute${m === 1 ? "" : "s"} ago`;
  }
  if (ms < 86_400_000) {
    const h = Math.round(ms / 3_600_000);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  if (ms < 7 * 86_400_000) {
    const days = Math.round(ms / 86_400_000);
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }
  return (tz ? absIn(tz) : ABS_TIME).format(date);
}

/** Absolute with a clock, in the runtime's zone (CLIENT components only). */
export function exact(d: Date | string | null): string {
  if (!d) return "";
  return ABS_TIME.format(typeof d === "string" ? new Date(d) : d);
}
