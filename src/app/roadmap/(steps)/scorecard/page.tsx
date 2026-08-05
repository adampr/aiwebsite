// Roadmap step 4: Employee Scorecard (§5.18). Derived entirely at read time
// from the directory joined to PUBLISHED company cards; held, failed, and
// in-review submissions never appear anywhere here, so the scorecard can
// never reveal that a colleague tried and failed. Zeros render faint, never
// in warning colors: not-yet is a state, not a verdict. The standing
// disclosure header is non-dismissible by design.

import type { Metadata } from "next";
import Link from "next/link";
import { requireRoadmapPage } from "@/lib/roadmap/access";
import { companyScorecard } from "@/lib/roadmap/db";
import { fmtDate } from "@/components/roadmap/dates";
import { AddToDirectory } from "./scorecard-islands";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Employee Scorecard · Your AI Roadmap",
  robots: { index: false, follow: false },
};

const faint = { color: "var(--xl-text-faint)" } as const;

export default async function RoadmapScorecardPage() {
  const gate = await requireRoadmapPage("/roadmap/scorecard");
  if (!gate.ok || !gate.principal.company) return null;
  const p = gate.principal;
  const company = gate.principal.company;
  const isAdmin = p.companyRole === "admin";

  const rows = await companyScorecard(company.id);
  const directoryRows = rows.filter((r) => r.inDirectory);
  const strayRows = rows.filter((r) => !r.inDirectory);
  const peopleCount = directoryRows.length;
  const shippedCount = directoryRows.filter((r) => r.published > 0).length;
  const totalPublished = rows.reduce((n, r) => n + r.published, 0);
  const ratioPct =
    peopleCount > 0 ? Math.round((shippedCount / peopleCount) * 100) : 0;

  const disclosure =
    `This scorecard counts published AI work submissions for each person in ` +
    `the ${company.name} directory. Everyone who signs in with a ` +
    `${company.domain} address can see it, and so can XL.net administrators. ` +
    `It counts published cards only; drafts and in-review submissions never ` +
    `appear here. It is maintained by ${company.name}'s own administrators, ` +
    `not by XL.net, and XL.net does not use it to evaluate anyone.`;

  return (
    <div className="space-y-10">
      <section>
        <span className="sys-label">Step 05 · Employee Scorecard</span>
        <h1 className="mt-4">Watch builders emerge</h1>
      </section>

      <section className="panel">
        <span className="sys-label">What This Is</span>
        <p className="mt-3 text-sm">{disclosure}</p>
      </section>

      {peopleCount === 0 && totalPublished === 0 ? (
        <section className="text-sm" style={faint}>
          <p>
            The scorecard draws from two places that are both still empty:
            the directory and the published work. Start with{" "}
            <Link href="/roadmap/directory">the directory</Link>, then{" "}
            <Link href="/roadmap/work">submit the first build</Link>.
          </p>
        </section>
      ) : (
        <>
          <section>
            <div className="stat">
              <div className="stat-value">
                {shippedCount} of {peopleCount}
              </div>
              <div className="stat-label">
                people have shipped AI-built work
              </div>
            </div>
            <div
              className="rmp-ratio mt-4"
              role="img"
              aria-label={`${shippedCount} of ${peopleCount} people have shipped AI-built work`}
            >
              <span style={{ width: `${ratioPct}%` }} />
            </div>
            {peopleCount === 0 && (
              <p className="mt-4 text-sm" style={faint}>
                No one is in the directory yet, so published work cannot be
                credited to people. Fill in{" "}
                <Link href="/roadmap/directory">step 2</Link> and this page
                comes alive.
              </p>
            )}
            {peopleCount > 0 && totalPublished === 0 && (
              <p className="mt-4 text-sm" style={faint}>
                Nothing published yet. The first card that survives the
                editorial panel puts its builder on the board;{" "}
                <Link href="/roadmap/work">step 3</Link> is where it starts.
              </p>
            )}
          </section>

          {rows.length > 0 && (
            <section className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="mono text-xs uppercase tracking-[0.2em] text-faint">
                    <th className="border-b border-[var(--xl-line)] py-2 pr-4 font-normal">
                      Person
                    </th>
                    <th className="border-b border-[var(--xl-line)] py-2 pr-4 font-normal">
                      Published
                    </th>
                    <th className="border-b border-[var(--xl-line)] py-2 font-normal">
                      Most recent
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {directoryRows.map((row) => (
                    <tr key={row.personId ?? row.email ?? row.name ?? ""}>
                      <td className="border-b border-[var(--xl-line)] py-2 pr-4">
                        {row.name ?? row.email}
                        {!row.email && (
                          <span className="mono ml-3 text-xs" style={faint}>
                            no email on file, submissions cannot be matched
                          </span>
                        )}
                      </td>
                      <td
                        className="border-b border-[var(--xl-line)] py-2 pr-4"
                        style={row.published === 0 ? faint : undefined}
                      >
                        {row.published}
                      </td>
                      <td
                        className="mono border-b border-[var(--xl-line)] py-2 text-xs"
                        style={row.published === 0 ? faint : undefined}
                      >
                        {row.lastPublishedAt
                          ? fmtDate(row.lastPublishedAt)
                          : "·"}
                      </td>
                    </tr>
                  ))}
                  {strayRows.map((row) => (
                    <tr key={`stray-${row.email}`}>
                      <td className="border-b border-[var(--xl-line)] py-2 pr-4">
                        <span className="mono text-xs">{row.email}</span>
                        <span className="badge ml-3">Not in directory</span>
                        {isAdmin && row.email && (
                          <span className="ml-3">
                            <AddToDirectory email={row.email} />
                          </span>
                        )}
                      </td>
                      <td className="border-b border-[var(--xl-line)] py-2 pr-4">
                        {row.published}
                      </td>
                      <td className="mono border-b border-[var(--xl-line)] py-2 text-xs">
                        {row.lastPublishedAt
                          ? fmtDate(row.lastPublishedAt)
                          : "·"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </div>
  );
}
