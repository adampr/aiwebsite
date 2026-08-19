"use client";

// The "Your Work" entry point in the global nav (§5.18).
//
// Renders only when the shared probe says the viewer's trusted session
// belongs to a company with at least one published card. Rendering is a UI
// convenience, NOT the control: every /roadmap route is gated server-side
// regardless of what the nav shows (staff-probe.ts doctrine). Signed-out
// visitors and @xl.net staff cost zero extra requests; company users cost
// one shared fetch per page (roadmap-probe.ts).

import Link from "next/link";
import { useEffect, useState } from "react";
import { probeYourWork } from "@/components/roadmap-probe";

export function YourWorkLink() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let alive = true;
    void probeYourWork().then((ok) => {
      if (alive && ok) setShow(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!show) return null;

  return (
    <span className="nav-staff">
      <span className="nav-staff-sep" aria-hidden="true" />
      <Link href="/roadmap/work">Your Work</Link>
    </span>
  );
}
