"use client";

// Relative-or-absolute timestamps that end up in the VIEWER's timezone
// (§5.17). Relative strings ("3 hours ago") are zone-free; the absolute
// branch (>7 days) is where the server's zone used to leak. Renders the
// same string the server computed, then re-renders once client-side so the
// absolute branch lands in the browser's zone. suppressHydrationWarning
// covers the boundary cases (the two clocks straddling a minute).

import { useEffect, useState } from "react";
import { when } from "@/lib/rfp/time";

export function When({ iso }: { iso: string }) {
  const [text, setText] = useState(() => when(iso));
  useEffect(() => {
    const t = window.setTimeout(() => setText(when(iso)), 0);
    return () => window.clearTimeout(t);
  }, [iso]);
  return (
    <time dateTime={iso} suppressHydrationWarning>
      {text}
    </time>
  );
}
