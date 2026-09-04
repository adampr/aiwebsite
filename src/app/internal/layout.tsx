// The /internal shell and its access gate (ARCHITECTURE.md §5.22).
//
// This layout gates, but it is NOT the only gate: a layout does not run for
// route handlers or server actions, and it renders once per segment tree, so
// every page under /internal re-checks via the same helper. Same
// defence-in-depth reasoning as src/app/rfp/layout.tsx and
// src/app/admin/layout.tsx — the layout owns the DENIAL SCREEN, each page owns
// its own decision to render anything at all.
//
// force-dynamic is load-bearing, not a default. The house posture for public
// pages is ISR (/work revalidates at 300s); a gated page inheriting that would
// be rendered once and handed to every subsequent viewer, gate included.
//
// The gate is /rfp's, reused rather than re-implemented (src/lib/rfp/access.ts
// — its header is the argument for why an @xl.net suffix test is not enough).
// The redirect target is the tree root's own path family: requireRfpPage()
// sends a signed-out visitor to /login?redirect=… ("redirect" is this host's
// login parameter), and returns a typed denial for a signed-in one so the
// screen below can explain rather than bounce a session that has already
// satisfied a login form.

import type { Metadata } from "next";
import Link from "next/link";
import { requireRfpPage } from "@/lib/rfp/access";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  // Inherited by every page under /internal that does not set its own. Never
  // indexed and never followed: robots.txt is a request, this is the
  // instruction that travels with the page.
  robots: { index: false, follow: false },
};

export default async function InternalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The tree root, not the leaf: this layout cannot know which page rendered
  // it, and /internal/xlant is where a signed-out staffer wants to land after
  // signing in. The one page under this tree today re-derives its own, exact
  // redirect target.
  const result = await requireRfpPage("/internal/xlant");

  if (!result.ok) {
    // Signed in, but not admissible. Explain rather than bounce to a login
    // form the visitor has already satisfied, and name the fix. The screen
    // deliberately does not say WHICH internal tool was asked for.
    return (
      <div className="mx-auto max-w-xl pt-12">
        <span className="sys-label">Internal Tools</span>
        <h1 className="mt-4 text-3xl font-bold">Staff access only</h1>
        <div className="panel panel--raised mt-6">
          {result.reason === "wrong_domain" ? (
            <p>
              XL.net internal tools are open to XL.net staff accounts. You are
              signed in as <span className="mono">{result.email}</span>. If you
              work at XL.net, sign in with your xl.net Google or Microsoft
              account.
            </p>
          ) : (
            <p>
              XL.net internal tools require a verified XL.net sign-in. You are
              signed in as <span className="mono">{result.email}</span>, but
              this session could not verify your address. Sign in again with
              your xl.net Google or Microsoft account and come back.
            </p>
          )}
          <p className="mt-4 text-sm text-faint">
            These tools reach XL-managed machines, so access is deliberately
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

  return <>{children}</>;
}
