"use client";

// Step-strip nav for the four roadmap step pages (§5.18): the hub link plus
// all four steps, current one highlighted via pathname. Client-only because
// a server layout cannot know the active child route; nothing sensitive
// rides through here (ROADMAP_STEPS is static public config).

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ROADMAP_STEPS } from "@/lib/roadmap/config";

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
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  );
}
