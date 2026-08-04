// Gate + shell for the four roadmap step pages (§5.18). force-dynamic and
// noindex; NO revalidate export anywhere under src/app/roadmap (gate-script
// rule). The layout renders denial screens itself (rfp doctrine: explain,
// never bounce) and each step page ALSO calls requireRoadmapPage - defense
// in depth; a page returns null when denied and this layout's screen is
// what the visitor sees. Nothing sensitive rides through client props.

import type { Metadata } from "next";
import Link from "next/link";
import { requireRoadmapPage } from "@/lib/roadmap/access";
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
  const gate = await requireRoadmapPage("/roadmap");

  if (!gate.ok) {
    // Untrusted provider: the hub owns the full "Confirm it is you" flow;
    // this shell explains and points there. No company data, not even a
    // name.
    return (
      <Denial
        title="Confirm it is you"
        body="Your sign-in method could not verify your email address, and company roadmaps are private to verified company addresses. The roadmap page has two quick ways to confirm."
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
