// Roadmap step 7: Employee Scorecard (§5.18 + §5.19). Derived entirely at
// read time from the directory joined to PUBLISHED company cards plus
// requested-work activity in LISTED statuses; held, failed, in-review,
// pending, and rejected rows never appear anywhere here, so the scorecard
// can never reveal that a colleague tried and failed. Zeros render faint,
// never in warning colors: not-yet is a state, not a verdict. The standing
// disclosure header is non-dismissible by design.
//
// STAFF LANE (§5.18 unification + staff parity): xl.net staff get the same
// page over the internal lane (the NULL-lane staff directory joined to
// public /work submissions + the /work/requested board), gated by
// readStaffPage BEFORE requireRoadmapPage - the (steps) layout admits
// staff, so a trusted-only gate here would render a blank shell. Person
// labels follow the ONE naming rule (src/lib/person-label.ts): First Last
// or email, never a bare single-token name.

import type { Metadata } from "next";
import Link from "next/link";
import { readStaffPage, requireRoadmapPage } from "@/lib/roadmap/access";
import { scorecardRows, type ScorecardRow } from "@/lib/roadmap/db";
import { personLabelParts } from "@/lib/person-label";
import { fmtDate } from "@/components/roadmap/dates";
import { AddToDirectory } from "./scorecard-islands";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Employee Scorecard · Your AI Roadmap",
  robots: { index: false, follow: false },
};

const faint = { color: "var(--xl-text-faint)" } as const;

/** A count cell: nonzero links to the click-through list with an sr-only
 * name suffix (a table of links all named "2" is useless in a screen-reader
 * link list); zero renders faint and unlinked (a link to a guaranteed-empty
 * page; zeros are a state, not a verdict). */
function CountCell({
  n,
  email,
  col,
  srSuffix,
}: {
  n: number;
  email: string | null;
  col: "requested" | "working" | "completed";
  srSuffix: string;
}) {
  if (n === 0 || !email) {
    return (
      <td className="border-b border-[var(--xl-line)] py-2 pr-4" style={faint}>
        {email ? "0" : "·"}
      </td>
    );
  }
  return (
    <td className="border-b border-[var(--xl-line)] py-2 pr-4">
      <Link
        href={`/roadmap/scorecard/requests?person=${encodeURIComponent(email)}&col=${col}`}
      >
        {n}
        <span className="sr-only"> {srSuffix}</span>
      </Link>
    </td>
  );
}

function ScoreRows({
  rows,
  isAdmin,
}: {
  rows: ScorecardRow[];
  isAdmin: boolean;
}) {
  return (
    <>
      {rows.map((row) => {
        // The person-label rule: "First Last" or the email; emails keep
        // their mono styling (kind, not label.includes("@")).
        const { label, kind } = personLabelParts(row.name, row.email);
        return (
          <tr key={row.personId ?? row.email ?? row.name ?? ""}>
            <td className="border-b border-[var(--xl-line)] py-2 pr-4">
              {kind === "email" ? (
                <span className="mono text-xs">{label}</span>
              ) : (
                label
              )}
              {!row.email && (
                <span className="mono ml-3 text-xs" style={faint}>
                  no email on file, submissions cannot be matched
                </span>
              )}
              {!row.inDirectory && (
                <>
                  <span className="badge ml-3">Not in directory</span>
                  {isAdmin && row.email && (
                    <span className="ml-3">
                      <AddToDirectory email={row.email} />
                    </span>
                  )}
                </>
              )}
            </td>
            <td
              className="border-b border-[var(--xl-line)] py-2 pr-4"
              style={row.published === 0 ? faint : undefined}
            >
              {row.published}
            </td>
            <CountCell
              n={row.requested}
              email={row.email}
              col="requested"
              srSuffix={`approved requests from ${label}`}
            />
            <CountCell
              n={row.working}
              email={row.email}
              col="working"
              srSuffix={`projects in progress for ${label}`}
            />
            <CountCell
              n={row.completed}
              email={row.email}
              col="completed"
              srSuffix={`validated completions by ${label}`}
            />
            <td
              className="mono border-b border-[var(--xl-line)] py-2 text-xs"
              style={row.published === 0 ? faint : undefined}
            >
              {row.lastPublishedAt ? fmtDate(row.lastPublishedAt) : "·"}
            </td>
          </tr>
        );
      })}
    </>
  );
}

const HEADERS = [
  "Person",
  "Published",
  "Requested",
  "Working on",
  "Completed",
  "Most recent",
] as const;

function HeaderRow() {
  return (
    <tr className="mono text-xs uppercase tracking-[0.2em] text-faint">
      {HEADERS.map((h, i) => (
        <th
          key={h}
          className={
            "border-b border-[var(--xl-line)] py-2 font-normal" +
            (i < HEADERS.length - 1 ? " pr-4" : "")
          }
        >
          {h}
        </th>
      ))}
    </tr>
  );
}

export default async function RoadmapScorecardPage() {
  const staff = await readStaffPage();
  if (staff) {
    const rows = await scorecardRows({ companyId: null });
    const directoryRows = rows.filter((r) => r.inDirectory);
    const strayRows = rows.filter((r) => !r.inDirectory);
    const disclosure =
      `This scorecard counts each person in the XL.net directory, their ` +
      `published cards on the public Our Work page, and their activity on ` +
      `the internal requested-work board: approved requests, projects ` +
      `being worked on, and validated completions. It is visible to ` +
      `signed-in XL.net staff. Drafts, in-review submissions, and pending ` +
      `or rejected requests never appear here, and it is not used to ` +
      `evaluate anyone.`;
    return (
      <div className="space-y-10">
        <section>
          <span className="sys-label">Step 07 · Employee Scorecard</span>
          <h1 className="mt-4">Watch builders emerge</h1>
        </section>
        <section className="panel">
          <span className="sys-label">What This Is</span>
          <p className="mt-3 text-sm">{disclosure}</p>
        </section>
        {rows.length === 0 ? (
          <section className="text-sm" style={faint}>
            <p>
              Nothing to count yet:{" "}
              <Link href="/roadmap/directory">the directory</Link> is empty,
              there are no published cards on{" "}
              <Link href="/work">Our Work</Link>, and nothing is on{" "}
              <Link href="/work/requested">the requested-work board</Link>.
            </p>
          </section>
        ) : (
          <section className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <HeaderRow />
              </thead>
              <tbody>
                <ScoreRows rows={directoryRows} isAdmin={staff.globalAdmin} />
                <ScoreRows rows={strayRows} isAdmin={staff.globalAdmin} />
              </tbody>
            </table>
          </section>
        )}
      </div>
    );
  }

  const gate = await requireRoadmapPage("/roadmap/scorecard");
  if (!gate.ok || !gate.principal.company) return null;
  const p = gate.principal;
  const company = gate.principal.company;
  const isAdmin = p.companyRole === "admin";

  const rows = await scorecardRows({ companyId: company.id });
  const directoryRows = rows.filter((r) => r.inDirectory);
  const strayRows = rows.filter((r) => !r.inDirectory);
  const peopleCount = directoryRows.length;
  const shippedCount = directoryRows.filter((r) => r.published > 0).length;
  const totalPublished = rows.reduce((n, r) => n + r.published, 0);
  const totalRequests = rows.reduce(
    (n, r) => n + r.requested + r.working + r.completed,
    0
  );
  const ratioPct =
    peopleCount > 0 ? Math.round((shippedCount / peopleCount) * 100) : 0;

  const disclosure =
    `This scorecard counts published AI work submissions for each person in ` +
    `the ${company.name} directory, along with requested work from step 05: ` +
    `approved requests, projects being worked on, and validated completions. ` +
    `Everyone who signs in with a ${company.domain} address can see it, and ` +
    `so can XL.net administrators. It counts published cards and approved ` +
    `requests only; drafts, in-review submissions, and pending or rejected ` +
    `requests never appear here. It is maintained by ${company.name}'s own ` +
    `administrators, not by XL.net, and XL.net does not use it to evaluate ` +
    `anyone.`;

  return (
    <div className="space-y-10">
      <section>
        <span className="sys-label">Step 07 · Employee Scorecard</span>
        <h1 className="mt-4">Watch builders emerge</h1>
      </section>

      <section className="panel">
        <span className="sys-label">What This Is</span>
        <p className="mt-3 text-sm">{disclosure}</p>
      </section>

      {peopleCount === 0 && totalPublished === 0 && totalRequests === 0 ? (
        <section className="text-sm" style={faint}>
          <p>
            The scorecard draws from places that are all still empty: the
            directory, the published work, and the requested-work board.
            Start with <Link href="/roadmap/directory">the directory</Link>,
            then <Link href="/roadmap/work">submit the first build</Link> or{" "}
            <Link href="/roadmap/request">request the first project</Link>.
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
                No one is in the directory yet, so work cannot be credited to
                people. Fill in{" "}
                <Link href="/roadmap/directory">step 2</Link> and this page
                comes alive.
              </p>
            )}
            {peopleCount > 0 && totalPublished === 0 && (
              <p className="mt-4 text-sm" style={faint}>
                Nothing published yet. The first card that survives the
                editorial panel puts its builder on the board;{" "}
                <Link href="/roadmap/work">step 4</Link> is where it starts.
              </p>
            )}
          </section>

          {rows.length > 0 && (
            <section className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <HeaderRow />
                </thead>
                <tbody>
                  <ScoreRows rows={directoryRows} isAdmin={isAdmin} />
                  <ScoreRows rows={strayRows} isAdmin={isAdmin} />
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </div>
  );
}
