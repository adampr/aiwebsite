// Roadmap step 2: Company Directory (§5.18). Server-renders the rows with
// the lane's scope and hydrates the table island with them; admins get
// Apollo import, add, inline edit, and two-click remove, members get the
// same table read-only.
//
// STAFF LANE (staff-parity round): xl.net staff get the REAL staff
// directory here - the NULL-company_id lane - instead of the old redirect
// to the scorecard. Read-only for every staffer; edit levers and the
// auto-init render only for global admins (the routes re-derive
// requireGlobalAdmin on every write). This render satisfies the (steps)
// blank-shell invariant for staff.

import type { Metadata } from "next";
import { readStaffPage, requireRoadmapPage } from "@/lib/roadmap/access";
import {
  STAFF_LANE_DOMAIN,
  roadmapEnabled,
} from "@/lib/roadmap/config";
import {
  STAFF_DIRECTORY_SCOPE,
  apolloImportStamp,
  countPeople,
  listPeople,
} from "@/lib/roadmap/db";
import { DirectoryTable, type DirectoryPerson } from "./directory-table";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Company Directory · Your AI Roadmap",
  robots: { index: false, follow: false },
};

function tableRows(
  people: Awaited<ReturnType<typeof listPeople>>
): DirectoryPerson[] {
  return people.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    source: row.source,
  }));
}

export default async function RoadmapDirectoryPage() {
  const staff = await readStaffPage();
  if (staff) {
    const [people, importStamp, total] = await Promise.all([
      listPeople(STAFF_DIRECTORY_SCOPE),
      apolloImportStamp(STAFF_DIRECTORY_SCOPE),
      countPeople(STAFF_DIRECTORY_SCOPE),
    ]);
    // The company auto-init predicate minus company.status (no companies
    // row exists for the staff lane; ROADMAP_ENABLED is its only write
    // kill switch). Same sessionStorage fence as the staff hub card via
    // STAFF_LANE_DOMAIN.
    const autoInit =
      staff.globalAdmin &&
      people.length === 0 &&
      importStamp === null &&
      roadmapEnabled(process.env) &&
      !!process.env.APOLLO_API_KEY;
    return (
      <div className="space-y-10">
        <section>
          <span className="sys-label">Step 02 · Company Directory</span>
          <h1 className="mt-4">The people on this journey</h1>
          <p className="mt-4 max-w-3xl text-sm">
            XL.net&apos;s directory feeds the scorecard: published work is
            counted per person listed here. Exactly name, email, and mobile
            number are kept, nothing more, and no one listed is ever
            contacted by this site.
          </p>
        </section>

        <DirectoryTable
          people={tableRows(people)}
          total={total}
          isAdmin={staff.globalAdmin}
          domain={STAFF_LANE_DOMAIN}
          autoInit={autoInit}
          visibilityNote="Import only people you are authorized to list. Directory entries are visible to everyone at XL.net who signs in."
          memberEmptyLine="An XL.net admin adds people here."
        />
      </div>
    );
  }

  const gate = await requireRoadmapPage("/roadmap/directory");
  if (!gate.ok || !gate.principal.company) return null;
  const p = gate.principal;
  const company = gate.principal.company;
  const isAdmin = p.companyRole === "admin";

  const [people, importStamp, total] = await Promise.all([
    listPeople({ companyId: company.id }),
    apolloImportStamp({ companyId: company.id }),
    countPeople({ companyId: company.id }),
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
          is counted per person listed here. Exactly name, email, and mobile
          number are kept, nothing more, and no one listed is ever contacted
          by this site.
        </p>
      </section>

      <DirectoryTable
        people={tableRows(people)}
        total={total}
        isAdmin={isAdmin}
        domain={company.domain}
        autoInit={autoInit}
      />
    </div>
  );
}
