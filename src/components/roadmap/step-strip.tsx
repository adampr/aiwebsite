"use client";

// Step-strip nav for the roadmap step pages (§5.18): the hub link plus all
// eight steps, current one highlighted via pathname. Client-only because a
// server layout cannot know the active child route; nothing sensitive rides
// through here (ROADMAP_STEPS and STAFF_STEP_HREFS are static public
// config).
//
// Two of the eight steps are paid training with no step page of their own:
// they link OUT to /builders, so aria-current can never match them (correct:
// /builders is never "the current page" inside this shell), and they carry
// their fee token so a link leaving the portal for a checkout page says so
// before it is clicked.
//
// staff mode (§5.18 unification): hrefs come from STAFF_STEP_HREFS (the ONE
// staff href map), several steps share a destination (/work/requested,
// /roadmap/scorecard), and most resolve outside this shell - so aria-current
// is claimed ONLY by the scorecard entry, the one staff destination that
// renders inside the (steps) shell. The company-mode `pathname === href`
// rule would double-highlight shared hrefs.

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ROADMAP_STEPS,
  STAFF_STEP_HREFS,
  isPaidStep,
} from "@/lib/roadmap/config";

export function StepStrip({ staff = false }: { staff?: boolean }) {
  const pathname = usePathname();
  return (
    <nav className="rmp-strip" aria-label="Roadmap steps">
      <Link href="/roadmap" className="rmp-strip-hub">
        Your AI Roadmap
      </Link>
      <ol className="rmp-strip-list">
        {ROADMAP_STEPS.map((step) => {
          const href = staff ? STAFF_STEP_HREFS[step.key] : step.href;
          // Scorecard claims its SUBTREE in both modes: the click-through
          // child (/roadmap/scorecard/requests) renders inside this shell
          // and an exact match would leave the strip with no current entry.
          const current =
            step.key === "scorecard"
              ? (pathname?.startsWith("/roadmap/scorecard") ?? false)
              : staff
                ? false
                : pathname === href;
          return (
            <li key={step.key}>
              <Link href={href} aria-current={current ? "page" : undefined}>
                {step.num} · {step.title}
                {isPaidStep(step) ? ` · ${step.fee}` : ""}
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
