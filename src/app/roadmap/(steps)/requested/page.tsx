// Roadmap step 06: Approved Requested Work (§5.19, company lane). The
// paginated board of approved requests every company member can see and
// claim (max 3 at a time), plus the company admin's approval queue. Staff
// sessions redirect to the canonical staff surface (STAFF_STEP_HREFS).

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { readStaffPage, requireRoadmapPage } from "@/lib/roadmap/access";
import { STAFF_STEP_HREFS } from "@/lib/roadmap/config";
import { REQUEST_CAPS } from "@/lib/work/requests-config";
import {
  boardList,
  developerActiveCount,
  pendingQueue,
} from "@/lib/work/requests-db";
import { RequestBoard } from "@/components/requests/request-board";
import { PendingQueue } from "@/components/requests/pending-queue";
import { toBoardRow, toQueueRow } from "@/components/requests/serialize";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Approved Requested Work · Your AI Roadmap",
  robots: { index: false, follow: false },
};

export default async function RoadmapRequestedPage() {
  const staff = await readStaffPage();
  if (staff) redirect(STAFF_STEP_HREFS.requested);
  const gate = await requireRoadmapPage("/roadmap/requested");
  if (!gate.ok || !gate.principal.company) return null;
  const p = gate.principal;
  const company = gate.principal.company;
  const scope = { companyId: company.id };
  const email = p.email.toLowerCase();
  const isAdmin = p.companyRole === "admin";

  const [board, activeClaims, queue] = await Promise.all([
    boardList(scope),
    developerActiveCount(scope, email),
    isAdmin ? pendingQueue(scope) : Promise.resolve([]),
  ]);

  return (
    <div className="space-y-10">
      <section>
        <span className="sys-label">Step 06 · Approved Requested Work</span>
        <h1 className="mt-4">The approved list</h1>
        <p className="mt-4 max-w-2xl text-sm">
          Every request an admin has approved, open to everyone at{" "}
          {company.name}: claim a project to build, up to{" "}
          {REQUEST_CAPS.concurrentPerDeveloper} at a time, and mark it
          complete when it ships. An admin validates every completion. File
          new requests on <Link href="/roadmap/request">step 05</Link>.
        </p>
      </section>

      {isAdmin && (
        <section className="panel space-y-4">
          <h2 className="mono text-xs uppercase tracking-[0.2em] text-light">
            Awaiting approval
          </h2>
          <PendingQueue rows={queue.map(toQueueRow)} />
        </section>
      )}

      <section className="panel space-y-4">
        <h2 className="mono text-xs uppercase tracking-[0.2em] text-light">
          The board
        </h2>
        <RequestBoard
          rows={board.map(toBoardRow)}
          viewerEmail={email}
          isAdmin={isAdmin}
          activeClaims={activeClaims}
          capped={board.length >= REQUEST_CAPS.listMax}
        />
      </section>
    </div>
  );
}
