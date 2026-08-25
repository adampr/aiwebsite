// /work/submit (§5.16): staff-only submission page for team-built tools.
// Server shell: session gate with deep-link redirect back after login;
// non-xl.net accounts get the instructive notice instead of the form.
// Deliberately absent from the sitemap and noindexed: this page addresses
// XL.net staff, not visitors.

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { readSession } from "@aicompany/core/auth/session";
import { isAdmin } from "@aicompany/core/auth/guard";
import { emailDomain, isVerifiedStaffProvider } from "@/lib/rfp/access";
import { siteConfig } from "site.config";
import {
  EMAIL_PROMISE,
  workSubmissionsEnabled,
  type WorkKind,
} from "@/lib/work/config";
import {
  canProposeUpdate,
  isUuid,
  staffTransferCandidates,
  submissionById,
  type TransferCandidate,
} from "@/lib/work/db";
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
  // VERIFIED staff, the same predicate /roadmap/directory renders the staff
  // directory behind (roadmap/access.ts isStaffSession) and the same one
  // verifiedWebAdmin is built from: Google, or Microsoft carrying the
  // per-login mv claim (the 2026-08-09 parity round), plus an exact-label
  // domain read. This page's own `allowed` gate above is deliberately
  // looser - a bare split("@") on any provider - which was fine while the
  // page showed the viewer nothing but their own rows, and is NOT fine for
  // the two things below.
  const verifiedStaff =
    isVerifiedStaffProvider(session) &&
    WORK_SUBMIT_DOMAINS.includes(emailDomain(session.email) ?? "");
  // The "All submissions" scope is gated on verifiedWebAdmin in the route
  // (§5.16 transfer round), so the BUTTON must be gated on the same
  // predicate: bare isAdmin passes a Microsoft common-tenant session that
  // the route then 403s, and a control that always fails is worse than one
  // that is absent. Mirrors src/lib/work/http.ts verifiedWebAdmin.
  const canListAll = admin && verifiedStaff;
  // ?update=<id> opens the form in update mode (§5.16). Same discipline as
  // the API's single 404: an id that is missing, unpublished, or not owned
  // silently falls back to the ordinary create form, revealing nothing.
  let updateTarget: UpdateTarget | null = null;
  const updateParam = (await searchParams).update;
  if (allowed && updateParam && isUuid(updateParam)) {
    const row = await submissionById(updateParam);
    // Chain ownership, matching the POST gate (2026-08-04): the published
    // row belongs to the LAST updater, but every submitter in the card's
    // supersede chain keeps the right to propose the next version.
    if (
      row &&
      row.status === "published" &&
      row.cardJson &&
      (await canProposeUpdate(row, session.email, admin))
    )
      updateTarget = {
        id: row.id,
        title: row.title,
        kind: row.kind as WorkKind,
      };
  }
  // §5.16 transfer round: type-ahead for "Move to someone else". A
  // CONVENIENCE, never the gate (the route's hard rule is the lane's
  // domain), because a colleague who has not signed in yet appears in none
  // of these sources and must still be able to receive work. A DB failure
  // degrades to a plain text field rather than to a broken page.
  //
  // Gated on verifiedStaff, NOT on `allowed`: this list is the XL.net staff
  // directory plus every xl.net account, and /roadmap/directory only shows
  // it to a provider-verified staff session. Handing the same rows to this
  // page's looser gate would widen that disclosure to any session a
  // common-tenant Microsoft login can mint. Everyone else keeps a plain
  // field, which the route validates identically.
  let transferCandidates: TransferCandidate[] = [];
  if (allowed && enabled && verifiedStaff) {
    try {
      transferCandidates = await staffTransferCandidates(WORK_SUBMIT_DOMAINS[0]);
    } catch {
      // no list, no type-ahead; the field still accepts a typed address
    }
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
          and publishes only what it can verify. {EMAIL_PROMISE}
        </p>
        <p className="mx-auto mt-4 text-xs text-faint">
          Prefer email? Send the package to Tron.Netter@ai.xl.net from your
          xl.net address with a normal note; Tron works out the rest and
          replies with what he did. Optional lines if you want control:
          {" "}&quot;Title:&quot;, &quot;Kind:&quot;, &quot;Credit:&quot;, and
          {" "}&quot;Update Card: (its exact title)&quot; to update a card you
          published.
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
          canListAll={canListAll}
          canTransfer={verifiedStaff}
          viewerEmail={session.email}
          transferCandidates={transferCandidates}
        />
      )}
    </div>
  );
}
