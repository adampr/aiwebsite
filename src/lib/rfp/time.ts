// Timestamp formatting for /rfp (§5.17).
//
// Relative under a week, absolute beyond it. A date on a row that never
// changes trains people to stop reading dates, so this is used only where
// freshness is the question being asked.

// No pinned zone: in client components this is the VIEWER's timezone.
// Server components must not use these for absolute times — they format in
// the VM's zone; use <LocalTime> (src/components/local-time.tsx) instead.
const ABS = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

const ABS_TIME = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZoneName: "short",
});

export function when(d: Date | string | null): string {
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
  return ABS.format(date);
}

/** Absolute with a clock, in the runtime's zone (CLIENT components only). */
export function exact(d: Date | string | null): string {
  if (!d) return "";
  return ABS_TIME.format(typeof d === "string" ? new Date(d) : d);
}
