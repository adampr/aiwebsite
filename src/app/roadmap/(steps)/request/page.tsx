// Roadmap step 05: Request AI-Built Work (§5.19, company lane). The request
// form plus the requester's own list - the ONE surface where their pending
// and rejected requests appear. The approved board lives on step 06
// (/roadmap/requested). Staff sessions redirect to the canonical staff
// surface (STAFF_STEP_HREFS; owner ruling: staff use /work/requested).

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { readStaffPage, requireRoadmapPage } from "@/lib/roadmap/access";
import { STAFF_STEP_HREFS } from "@/lib/roadmap/config";
import { REQUEST_CAPS } from "@/lib/work/requests-config";
import { mineList, requesterOpenCount } from "@/lib/work/requests-db";
import { RequestForm } from "@/components/requests/request-form";
import { MyRequests } from "@/components/requests/my-requests";
import { toMineRow } from "@/components/requests/serialize";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Request AI-Built Work · Your AI Roadmap",
  robots: { index: false, follow: false },
};

export default async function RoadmapRequestPage() {
  const staff = await readStaffPage();
  if (staff) redirect(STAFF_STEP_HREFS.request);
  const gate = await requireRoadmapPage("/roadmap/request");
  if (!gate.ok || !gate.principal.company) return null;
  const p = gate.principal;
  const company = gate.principal.company;
  const scope = { companyId: company.id };
  const email = p.email.toLowerCase();

  const [mine, openCount] = await Promise.all([
    mineList(scope, email),
    requesterOpenCount(scope, email),
  ]);

  return (
    <div className="space-y-10">
      <section>
        <span className="sys-label">Step 05 · Request AI-Built Work</span>
        <h1 className="mt-4">Ask for a project worth building</h1>
        <p className="mt-4 max-w-2xl text-sm">
          Describe the project, put an estimated annual value in dollars on
          it, and list the metrics behind that number. An admin reviews every
          request; approved ones go on{" "}
          <Link href="/roadmap/requested">the approved list</Link> where
          anyone at {company.name} can claim and build them.
        </p>
      </section>

      <section className="panel panel--raised">
        <h2 className="mono text-xs uppercase tracking-[0.2em] text-light">
          Request a project
        </h2>
        <div className="mt-4">
          <RequestForm openCount={openCount} />
        </div>
      </section>

      <section className="panel space-y-4">
        <h2 className="mono text-xs uppercase tracking-[0.2em] text-light">
          Your requests
        </h2>
        <MyRequests
          rows={mine.map(toMineRow)}
          capped={mine.length >= REQUEST_CAPS.listMax}
        />
      </section>
    </div>
  );
}
