// Gate + shell for the six roadmap step pages (§5.18; steps 03 and 08 are
// paid training on /builders and have no page here). force-dynamic and
// noindex; NO revalidate export anywhere under src/app/roadmap (gate-script
// rule). The layout renders denial screens itself (rfp doctrine: explain,
// never bounce) and each step page ALSO calls requireRoadmapPage - defense
// in depth; a page returns null when denied and this layout's screen is
// what the visitor sees. Nothing sensitive rides through client props.
//
// SHELL RUNWAY (staff-parity round, owner ask): the shell renders the
// hub-identical Lightline Runway above the step content in BOTH lanes,
// replacing the retired text step-strip nav. The status bundle is computed HERE
// (company: roadmapStatus, incl. the budget-bounded cached DKIM probe
// riding its Promise.all; staff: staffRoadmapStatus) so the shell runway
// can never disagree with the hub. Notes:
//  - App Router layouts are NOT re-fetched on sibling step-to-step
//    navigation, so the runway is a snapshot from shell entry; every
//    mutation island already calls router.refresh(), which re-renders this
//    layout, so it relights immediately after the user acts.
//  - aria-current is deliberately absent (hub parity; a server layout
//    cannot know the active child segment, and each step page's own
//    "Step NN" header announces location).
//  - The runway's #rmp-node-directory / #rmp-sr-directory ids render here
//    too but are UNDRIVEN on step pages (DirectoryCard on the hub is the
//    only island driver; see runway.tsx ISLAND CONTRACT).
//
// STAFF (§5.18 unification): xl.net staff sessions are admitted to the
// shell FIRST, before the trusted-principal gate (readRoadmapHubView's
// load-bearing ordering: pre-hardening staff sessions have no mv and xl.net
// is reserved). INVARIANT: every (steps) page must then either render a
// staff variant or redirect staff to its STAFF_STEP_HREFS target - a page
// that returns null for staff renders a BLANK shell, because the layout's
// denial screens only exist on the non-staff path (pinned in
// scripts/roadmap-tests.ts).

import type { Metadata } from "next";
import Link from "next/link";
import { readStaffPage, requireRoadmapPage } from "@/lib/roadmap/access";
import { STAFF_STEP_HREFS, type RoadmapStepKey } from "@/lib/roadmap/config";
import { roadmapStatus, staffRoadmapStatus } from "@/lib/roadmap/status";
import {
  RoadmapRunway,
  RunwayStage,
  type RunwayStatus,
} from "@/components/roadmap/runway";
import "../roadmap.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

function Denial({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto max-w-xl space-y-6 pt-8 text-center">
      <span className="sys-label sys-label--center">Your AI Roadmap</span>
      <h1>{title}</h1>
      <p className="text-sm">{body}</p>
      <div>
        <Link href="/roadmap" className="btn no-underline">
          Back to the roadmap
        </Link>
      </div>
    </div>
  );
}

/** The shell chrome: a hub link, then the bare runway (the "Start wherever
 * helps most" caption is hub-only copy). mt-8 also gives the lg hover
 * tooltip (which pops above the node) its headroom at the top of the
 * shell. */
function ShellRunway({
  status,
  hrefs,
}: {
  status: RunwayStatus;
  hrefs?: Readonly<Record<RoadmapStepKey, string>>;
}) {
  return (
    <nav aria-label="Roadmap steps" className="pt-4">
      <p>
        <Link href="/roadmap" className="btn btn--text no-underline">
          <span aria-hidden="true">←</span> Your AI Roadmap
        </Link>
      </p>
      <div className="mt-8">
        <RunwayStage>
          <RoadmapRunway status={status} hrefs={hrefs} />
        </RunwayStage>
      </div>
    </nav>
  );
}

export default async function RoadmapStepsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const staff = await readStaffPage();
  if (staff) {
    const staffStatus = await staffRoadmapStatus();
    return (
      <div className="mx-auto max-w-5xl space-y-10">
        <ShellRunway status={staffStatus} hrefs={STAFF_STEP_HREFS} />
        {children}
      </div>
    );
  }

  const gate = await requireRoadmapPage("/roadmap");

  if (!gate.ok) {
    // Untrusted provider: the hub owns the full "One last check"
    // verification flow; this shell explains and points there. No company
    // data, not even a name.
    return (
      <Denial
        title="One last check"
        body="You are signed in and your session is fine, but we confirm once that your email address really belongs to your account before showing company data. The roadmap page runs that quick check."
      />
    );
  }

  if (!gate.principal.company) {
    return (
      <Denial
        title="No workspace yet"
        body="These step pages belong to a company workspace, and your account is not part of one yet. Start on the roadmap page: sign in with your work email and set up or join your company's workspace."
      />
    );
  }

  const company = gate.principal.company;
  const status = await roadmapStatus(company.id, company.domain);
  return (
    <div className="mx-auto max-w-5xl space-y-10">
      <ShellRunway status={status} />
      {children}
    </div>
  );
}
