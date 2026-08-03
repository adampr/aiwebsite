// /work/submit (§5.16): staff-only submission page for team-built tools.
// Server shell: session gate with deep-link redirect back after login;
// non-xl.net accounts get the instructive notice instead of the form.
// Deliberately absent from the sitemap and noindexed: this page addresses
// XL.net staff, not visitors.

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { readSession } from "@aicompany/core/auth/session";
import { isAdmin } from "@aicompany/core/auth/guard";
import { siteConfig } from "site.config";
import { workSubmissionsEnabled, type WorkKind } from "@/lib/work/config";
import { isUuid, submissionById } from "@/lib/work/db";
import { WORK_SUBMIT_DOMAINS } from "@/lib/work/http";
import { SubmitClient, type UpdateTarget } from "./submit-client";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Submit Your Build",
  robots: { index: false, follow: false },
};

export default async function WorkSubmitPage({
  searchParams,
}: {
  searchParams: Promise<{ update?: string }>;
}) {
  const session = await readSession(siteConfig);
  if (!session) redirect(`/login?redirect=${encodeURIComponent("/work/submit")}`);
  const domain = session.email.split("@")[1]?.toLowerCase() ?? "";
  const allowed = WORK_SUBMIT_DOMAINS.includes(domain);
  const enabled = workSubmissionsEnabled(process.env);
  const admin = isAdmin(session.email);
  // ?update=<id> opens the form in update mode (§5.16). Same discipline as
  // the API's single 404: an id that is missing, unpublished, or not owned
  // silently falls back to the ordinary create form, revealing nothing.
  let updateTarget: UpdateTarget | null = null;
  const updateParam = (await searchParams).update;
  if (allowed && updateParam && isUuid(updateParam)) {
    const row = await submissionById(updateParam);
    if (
      row &&
      row.status === "published" &&
      row.cardJson &&
      (row.submitterEmail.toLowerCase() === session.email.toLowerCase() ||
        admin)
    )
      updateTarget = {
        id: row.id,
        title: row.title,
        kind: row.kind as WorkKind,
      };
  }
  return (
    <div className="mx-auto max-w-2xl space-y-8 pt-12">
      <div className="text-center">
        <span className="sys-label sys-label--center">
          Our Work / Submit Your Build
        </span>
        <h1 className="mt-8">Submit a tool you built</h1>
        <p className="mx-auto mt-6 text-sm">
          A CoWork Skill (the .skill with its SKILL.md, in one upload or
          two) or a Code program (a .zip with its architecture.md). An automated editorial
          panel drafts a /work card from those documents, argues against it,
          and publishes only what it can verify. You get an email either way.
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
        <SubmitClient
          isAdmin={admin}
          adminEmail={
            process.env.ADMIN_EMAIL?.split(",")[0]?.trim() || "adam@xl.net"
          }
          updateTarget={updateTarget}
        />
      )}
    </div>
  );
}
