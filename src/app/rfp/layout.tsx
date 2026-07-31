// The /rfp shell and its access gate (§5.17).
//
// This layout gates, but it is NOT the only gate: a layout does not run for
// route handlers or server actions, so every page and any future handler
// re-checks via src/lib/rfp/access.ts. Same defence-in-depth reasoning as
// src/app/admin/layout.tsx.
//
// force-dynamic is load-bearing, not a default. The house posture for public
// pages is ISR (/work revalidates at 300s); a gated page inheriting that would
// be rendered once and handed to every subsequent viewer, gate included.

import type { Metadata } from "next";
import Link from "next/link";
import { requireRfpPage } from "@/lib/rfp/access";
import { RfpTabs } from "./tabs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "RFP Response",
  // Never indexed, and never followed: robots.txt is a request, this is the
  // instruction that travels with the page.
  robots: { index: false, follow: false },
};

export default async function RfpLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const result = await requireRfpPage("/rfp");

  if (!result.ok) {
    // Signed in, but not admissible. Explain rather than bounce to a login
    // form the visitor has already satisfied, and name the fix.
    return (
      <div className="mx-auto max-w-xl pt-12">
        <span className="sys-label">RFP Response</span>
        <h1 className="mt-4 text-3xl font-bold">Staff access only</h1>
        <div className="panel panel--raised mt-6">
          {result.reason === "wrong_domain" ? (
            <p>
              RFP Response is open to XL.net staff accounts. You are signed in
              as{" "}
              <span className="mono">{result.email}</span>. If you work at
              XL.net, sign in with your xl.net Google account.
            </p>
          ) : (
            <p>
              RFP Response requires an XL.net Google sign-in. You are signed in
              as{" "}
              <span className="mono">{result.email}</span>{" "}
              using a different provider. Sign out and choose Continue with
              Google.
            </p>
          )}
          <p className="mt-4 text-sm text-faint">
            This section holds commercial material, so access is deliberately
            narrower than the rest of the site.
          </p>
          <p className="mt-6">
            <Link href="/" className="btn btn--text">
              Back to the site
            </Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rfp-page">
      <div className="workbar mb-8">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3">
          <span className="badge badge--sand">Internal</span>
          <h1 className="min-w-0 text-lg" style={{ letterSpacing: "0.1em" }}>
            RFP Response
          </h1>
          <span
            className="ml-auto mono text-xs"
            style={{ color: "var(--xl-text-faint)" }}
          >
            {result.user.email}
          </span>
        </div>
        <RfpTabs admin={result.user.admin} />
      </div>

      {children}

      <div className="mt-16 flex justify-center">
        <p className="staff-bar">
          <span className="badge badge--sand">Internal</span>
          <span className="text-faint">
            XL.net commercial material. Not for slides, screenshots, or anything
            outside XL.net.
          </span>
        </p>
      </div>
    </div>
  );
}
