"use client";

// The site-wide AI Roadmap completion badge (§5.20, owner ask: "the company
// should prominently display its current AI Roadmap completion percentage
// for all of the company users anywhere on the site").
//
// It rides the SAME shared nav probe as the "Your Work" link, so a signed-in
// company user pays one fetch per page for both, and a signed-out visitor
// pays nothing and sees nothing. Rendering is a convenience, never a
// control: every roadmap surface is gated server-side regardless.
//
// The number is a LINK to /roadmap, because a percentage with nowhere to go
// is a nag rather than a way in.

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  probeRoadmapNav,
  subscribeRoadmapNav,
} from "@/components/roadmap-probe";

export function RoadmapPercentBadge() {
  const [percent, setPercent] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const read = () => {
      void probeRoadmapNav().then((d) => {
        if (!alive) return;
        // A null percent (signed out, no workspace, or a limiter refusal)
        // LEAVES the last known number alone rather than yanking the badge
        // off the page mid-session.
        if (typeof d.percent === "number") setPercent(d.percent);
      });
    };
    read();
    // Re-read whenever a mutation island resets the shared probe, so
    // completing a step updates the nav without a full page load.
    const unsubscribe = subscribeRoadmapNav(read);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  if (percent === null) return null;

  return (
    <span className="nav-staff">
      <span className="nav-staff-sep" aria-hidden="true" />
      <Link href="/roadmap" className="rmp-badge">
        {/* The bar is decorative reinforcement of the number beside it, so
            it is aria-hidden and the link's own text carries the meaning.
            No role="progressbar": this is navigation, not a live task. */}
        <span className="rmp-badge-track" aria-hidden="true">
          <span
            className="rmp-badge-fill"
            style={{ width: `${percent}%` }}
          />
        </span>
        <span className="rmp-badge-num">{percent}%</span>
        <span className="sr-only"> of your AI Roadmap complete</span>
      </Link>
    </span>
  );
}
