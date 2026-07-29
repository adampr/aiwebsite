// /work/submit (§5.16): staff-only submission page for team-built tools.
// Server shell: session gate with deep-link redirect back after login;
// non-xl.net accounts get the instructive notice instead of the form.
// Deliberately absent from the sitemap and noindexed: this page addresses
// XL.net staff, not visitors.

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { readSession } from "@aicompany/core/auth/session";
import { siteConfig } from "site.config";
import { workSubmissionsEnabled } from "@/lib/work/config";
import { WORK_SUBMIT_DOMAINS } from "@/lib/work/http";
import { SubmitClient } from "./submit-client";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Submit Your Build",
  robots: { index: false, follow: false },
};

export default async function WorkSubmitPage() {
  const session = await readSession(siteConfig);
  if (!session) redirect(`/login?redirect=${encodeURIComponent("/work/submit")}`);
  const domain = session.email.split("@")[1]?.toLowerCase() ?? "";
  const allowed = WORK_SUBMIT_DOMAINS.includes(domain);
  const enabled = workSubmissionsEnabled(process.env);
  return (
    <div className="mx-auto max-w-2xl space-y-8 pt-12">
      <div className="text-center">
        <span className="sys-label sys-label--center">
          Our Work / Submit Your Build
        </span>
        <h1 className="mt-8">Submit a tool you built</h1>
        <p className="mx-auto mt-6 text-sm">
          A CoWork skill or a Claude Code program, with the documents to back
          it. An automated editorial panel drafts a /work card from those
          documents, argues against it, and publishes only what it can
          verify. You get an email either way.
        </p>
      </div>
      {!allowed ? (
        <div className="panel panel--raised">
          <p className="text-sm">
            Submissions are open to XL.net staff accounts. You are signed in
            as {session.email}. If you work at XL.net, sign in with your
            xl.net Google or Microsoft account.
          </p>
        </div>
      ) : !enabled ? (
        <div className="panel panel--raised">
          <p className="text-sm">
            Submissions are paused right now. Published cards are unaffected.
            Check back later.
          </p>
        </div>
      ) : (
        <SubmitClient />
      )}
    </div>
  );
}
