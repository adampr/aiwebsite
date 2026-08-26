"use client";

// Relative-or-absolute timestamps that end up in the VIEWER's timezone
// (§5.17). Relative strings ("3 hours ago") are zone-free; the absolute
// branch (>7 days) is where the server's zone leaks, so that is the branch
// this component exists to correct.
//
// The seed is PINNED to UTC, which is the whole mechanism. It has to be,
// twice over:
//
//   1. React runs this component during SSR, so the server renders THE SEED
//      ITSELF - not a server-zone formatting of its own. The seed is
//      UTC-pinned by construction, so the SSR text and the first client
//      render are byte-identical whatever zone either machine is in;
//      measured identical under TZ=UTC, America/New_York, Asia/Tokyo and
//      Pacific/Kiritimati. The guarantee is unconditional, NOT contingent on
//      the VM happening to be UTC - if the VM's zone ever moved, this would
//      still hold. Hydration matches with nothing to patch and there is no
//      full-root re-render.
//   2. The post-mount value is then a genuinely DIFFERENT string for any
//      viewer who is not on UTC, so React commits it. Seeding with an
//      unpinned when(iso) instead reads the BROWSER's zone at seed time and
//      the effect recomputes the same string milliseconds later; React's
//      eager-state bailout (objectIs(eagerState, currentState)) drops the
//      update, no commit ever happens, and because suppressHydrationWarning
//      only silences the warning - that path never calls setTextContent - the
//      DOM keeps the SERVER's text forever. That shipped the VM's UTC date to
//      every reader while looking like it was doing the opposite. Measured,
//      not reasoned about.
//
// suppressHydrationWarning stays, but as a boundary case only, never the
// mechanism: the relative branch measures against Date.now(), which moves
// between the server render and hydration, so "59 minutes ago" can legally
// become "1 hour ago" on its own.

import { useEffect, useState } from "react";
import { when } from "@/lib/rfp/time";

export function When({ iso }: { iso: string }) {
  const [text, setText] = useState(() => when(iso, "UTC"));
  useEffect(() => {
    // Deferred a tick (the repo's pattern for view-following state), which
    // also satisfies the no-sync-setState-in-effect rule. No tz argument:
    // unpinned in the browser IS the viewer's zone.
    const t = window.setTimeout(() => setText(when(iso)), 0);
    return () => window.clearTimeout(t);
  }, [iso]);
  return (
    <time dateTime={iso} suppressHydrationWarning>
      {text}
    </time>
  );
}
