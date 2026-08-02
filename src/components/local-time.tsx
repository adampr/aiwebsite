"use client";

// Absolute timestamps in the VIEWER's timezone (§5.17). Server components
// can only format in the server's zone (UTC on the VM), which is how the
// activity log ended up captioned "12:02 PM UTC" for a reader in Chicago.
// This renders the UTC string server-side (so there is no layout shift and
// no hydration mismatch), then swaps to the browser's zone after mount.

import { useEffect, useState } from "react";

const utc = (iso: string, withTime: boolean) =>
  new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    ...(withTime ? { hour: "2-digit" as const, minute: "2-digit" as const } : {}),
    timeZone: "UTC",
  }).format(new Date(iso)) + (withTime ? " UTC" : "");

export function LocalTime({
  iso,
  withTime = false,
}: {
  iso: string;
  withTime?: boolean;
}) {
  const [text, setText] = useState(() => utc(iso, withTime));
  useEffect(() => {
    // Deferred a tick (the repo's pattern for view-following state), which
    // also satisfies the no-sync-setState-in-effect rule.
    const t = window.setTimeout(() => {
      setText(
        new Intl.DateTimeFormat("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
          ...(withTime
            ? {
                hour: "2-digit" as const,
                minute: "2-digit" as const,
                timeZoneName: "short" as const,
              }
            : {}),
        }).format(new Date(iso))
      );
    }, 0);
    return () => window.clearTimeout(t);
  }, [iso, withTime]);
  return <time dateTime={iso}>{text}</time>;
}
