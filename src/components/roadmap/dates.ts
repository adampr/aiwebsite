// Date rendering for roadmap surfaces. Pure and import-safe from server and
// client components alike. UTC on purpose: these pages are force-dynamic
// server renders, and a server-zone date would flicker against a client
// re-render; date-only precision makes the zone question immaterial.

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
