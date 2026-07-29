"use client";

// Staff-only entry point to /work/submit (§5.16). /work is ISR-cached so the
// server render cannot vary by viewer; this island asks /api/auth/session in
// the browser and renders the submit line ONLY for a signed-in @xl.net
// account. Public visitors (and logged-out staff) get nothing: the marketing
// page carries no staff-facing copy, which is why the empty community
// section deliberately renders no link of its own.

import Link from "next/link";
import { useEffect, useState } from "react";

export function StaffSubmitLink() {
  const [staff, setStaff] = useState(false);
  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/auth/session", { signal: ctrl.signal, cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (d: { authenticated?: boolean; user?: { email?: string } } | null) => {
          if (
            d?.authenticated &&
            typeof d.user?.email === "string" &&
            d.user.email.toLowerCase().endsWith("@xl.net")
          )
            setStaff(true);
        }
      )
      .catch(() => {
        // signed-out is the default; a failed probe changes nothing
      });
    return () => ctrl.abort();
  }, []);
  if (!staff) return null;
  return (
    <p className="mono text-center text-xs text-faint">
      On the XL.net team and built something?{" "}
      <Link href="/work/submit">Submit it for review.</Link>
    </p>
  );
}
