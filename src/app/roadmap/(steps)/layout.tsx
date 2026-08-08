// Gate + shell for the six roadmap step pages (§5.18; steps 03 and 08 are
// paid training on /builders and have no page here). force-dynamic and
// noindex; NO revalidate export anywhere under src/app/roadmap (gate-script
// rule). The layout renders denial screens itself (rfp doctrine: explain,
// never bounce) and each step page ALSO calls requireRoadmapPage - defense
// in depth; a page returns null when denied and this layout's screen is
// what the visitor sees. Nothing sensitive rides through client props.
//
// STAFF (§5.18 unification): xl.net staff sessions are admitted to the
// shell FIRST, before the trusted-principal gate (readRoadmapHubView's
// load-bearing ordering: pre-hardening staff sessions have no mv and xl.net
// is reserved). The shell renders only static config (StepStrip) plus
// children; INVARIANT: every (steps) page must then either render a staff
// variant or redirect staff to its STAFF_STEP_HREFS target - a page that
// returns null for staff renders a BLANK shell, because the layout's denial
// screens only exist on the non-staff path (pinned in
// scripts/roadmap-tests.ts).

import type { Metadata } from "next";
import Link from "next/link";
import { readStaffPage, requireRoadmapPage } from "@/lib/roadmap/access";
import { StepStrip } from "@/components/roadmap/step-strip";
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

export default async function RoadmapStepsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const staff = await readStaffPage();
  if (staff) {
    return (
      <div className="mx-auto max-w-5xl space-y-10">
        <div className="pt-4">
          <StepStrip staff />
        </div>
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

  return (
    <div className="mx-auto max-w-5xl space-y-10">
      <div className="pt-4">
        <StepStrip />
      </div>
      {children}
    </div>
  );
}
