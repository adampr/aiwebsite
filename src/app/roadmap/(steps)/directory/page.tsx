// Roadmap step 2: Company Directory (§5.18). Server-renders the rows with
// the principal's company id and hydrates the table island with them;
// admins get Apollo import, add, inline edit, and two-click remove, members
// get the same table read-only.

import type { Metadata } from "next";
import { readStaffPage, requireRoadmapPage } from "@/lib/roadmap/access";
import { redirect } from "next/navigation";
import { roadmapEnabled, STAFF_STEP_HREFS } from "@/lib/roadmap/config";
import { apolloImportStamp, listPeople } from "@/lib/roadmap/db";
import { DirectoryTable } from "./directory-table";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Company Directory · Your AI Roadmap",
  robots: { index: false, follow: false },
};

export default async function RoadmapDirectoryPage() {
  // Staff lane alias (§5.18 unification): XL.net's builder list is derived
  // from published work on the staff scorecard.
  if (await readStaffPage()) redirect(STAFF_STEP_HREFS.directory);
  const gate = await requireRoadmapPage("/roadmap/directory");
  if (!gate.ok || !gate.principal.company) return null;
  const p = gate.principal;
  const company = gate.principal.company;
  const isAdmin = p.companyRole === "admin";

  const [people, importStamp] = await Promise.all([
    listPeople(company.id),
    apolloImportStamp(company.id),
  ]);

  // Auto-init parity with the hub (round 3): the SAME server predicate. The
  // shared sessionStorage guard key (apolloKickGuardKey) makes hub -> step
  // navigation not double-kick.
  const autoInit =
    isAdmin &&
    people.length === 0 &&
    importStamp === null &&
    company.status === "active" &&
    roadmapEnabled(process.env) &&
    !!process.env.APOLLO_API_KEY;

  return (
    <div className="space-y-10">
      <section>
        <span className="sys-label">Step 02 · Company Directory</span>
        <h1 className="mt-4">The people on this journey</h1>
        <p className="mt-4 max-w-3xl text-sm">
          {company.name}&apos;s directory feeds the scorecard: published work
          is counted per person listed here. Exactly name, email, and phone
          are kept, nothing more, and no one listed is ever contacted by this
          site.
        </p>
      </section>

      <DirectoryTable
        people={people.map((row) => ({
          id: row.id,
          name: row.name,
          email: row.email,
          phone: row.phone,
          source: row.source,
        }))}
        isAdmin={isAdmin}
        domain={company.domain}
        autoInit={autoInit}
      />
    </div>
  );
}
