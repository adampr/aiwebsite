"use client";

// Step-strip nav for the roadmap step pages (§5.18): the hub link plus all
// six steps, current one highlighted via pathname. Client-only because a
// server layout cannot know the active child route; nothing sensitive rides
// through here (ROADMAP_STEPS is static public config).
//
// Two of the six steps are paid training with no step page of their own:
// they link OUT to /builders, so aria-current can never match them (correct:
// /builders is never "the current page" inside this shell), and they carry
// their fee token so a link leaving the portal for a checkout page says so
// before it is clicked.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ROADMAP_STEPS, isPaidStep } from "@/lib/roadmap/config";

export function StepStrip() {
  const pathname = usePathname();
  return (
    <nav className="rmp-strip" aria-label="Roadmap steps">
      <Link href="/roadmap" className="rmp-strip-hub">
        Your AI Roadmap
      </Link>
      <ol className="rmp-strip-list">
        {ROADMAP_STEPS.map((step) => (
          <li key={step.key}>
            <Link
              href={step.href}
              aria-current={pathname === step.href ? "page" : undefined}
            >
              {step.num} · {step.title}
              {isPaidStep(step) ? ` · ${step.fee}` : ""}
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  );
}
