// Roadmap step 2: Company Directory (§5.18). Server-renders the rows with
// the principal's company id and hydrates the table island with them;
// admins get Apollo import, add, inline edit, and two-click remove, members
// get the same table read-only.

import type { Metadata } from "next";
import { requireRoadmapPage } from "@/lib/roadmap/access";
import { listPeople } from "@/lib/roadmap/db";
import { DirectoryTable } from "./directory-table";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Company Directory · Your AI Roadmap",
  robots: { index: false, follow: false },
};

export default async function RoadmapDirectoryPage() {
  const gate = await requireRoadmapPage("/roadmap/directory");
  if (!gate.ok || !gate.principal.company) return null;
  const p = gate.principal;
  const company = gate.principal.company;
  const isAdmin = p.companyRole === "admin";

  const people = await listPeople(company.id);

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
      />
    </div>
  );
}
