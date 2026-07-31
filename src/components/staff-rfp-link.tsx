"use client";

// The /rfp entry point in the global nav (§5.17).
//
// The root layout is a NON-async server component and every public page's
// static render depends on it staying that way, so the link cannot be
// server-rendered from viewer session state. This island asks the shared probe
// (src/components/staff-probe.ts) and renders only for a signed-in xl.net
// Google account, which is the same predicate the server gate enforces.
//
// Rendering nothing for everyone else is a UI convenience, NOT the control:
// the section is gated server-side on every route regardless of what the nav
// shows. No space is reserved, matching the accepted one-line staff layout
// shift on /work.

import Link from "next/link";
import { useEffect, useState } from "react";
import { probeRfpStaff } from "@/components/staff-probe";

export function StaffRfpLink() {
  const [staff, setStaff] = useState(false);

  useEffect(() => {
    let alive = true;
    void probeRfpStaff().then((ok) => {
      if (alive && ok) setStaff(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!staff) return null;

  return (
    <span className="nav-staff">
      <span className="nav-staff-sep" aria-hidden="true" />
      <Link href="/rfp" aria-label="RFP Response, staff only">
        RFP Response
      </Link>
    </span>
  );
}
