// /admin/roadmap (§5.18): the global-admin console for client-company
// workspaces. Self-guarding server component with the PROVIDER-CHECKED
// predicate (requireGlobalAdmin semantics inline; bare isAdmin is forgeable
// via the Microsoft common-tenant lane and this console renders client
// data). List view = metadata allowlist (domain, name, status, counts,
// admin roster, last import) - never content columns - plus one synthetic
// pinned XL.net row for the staff lane (by hard invariant xl.net is NEVER a
// companies row; its data lives in the NULL-company_id lanes). The
// ?companyId detail view shows the directory and doc titles because there
// the directory IS the thing being administered; the literal token
// ?companyId=staff selects the staff-lane detail and is branched BEFORE
// companyById ("staff" is not a uuid; a uuid-column eq would throw 22P02).
// ?companyId request params are legal ONLY under this guard.

export const dynamic = "force-dynamic";

import Link from "next/link";
import { redirect } from "next/navigation";
import { readSession } from "@aicompany/core/auth/session";
import { isAdmin } from "@aicompany/core/auth/guard";
import { siteConfig } from "site.config";
import { emailDomain, isVerifiedStaffProvider } from "@/lib/rfp/access";
import { LocalTime } from "@/components/local-time";
import { StaffVerifyNotice } from "@/components/staff-verify-notice";
import { roadmapEnabled, ROADMAP_CAPS } from "@/lib/roadmap/config";
import {
  allPendingRequests,
  companiesOverview,
  companyAdminsDetail,
  companyById,
  countGovernanceDocs,
  countPeople,
  listGovernanceDocs,
  listPeople,
  readAttendance,
  readTodayRoadmapUsage,
  STAFF_GOVDOC_SCOPE,
} from "@/lib/roadmap/db";
import {
  companySubmissions,
  countStaffPublished,
  countStaffSubmissions,
  staffSubmissions,
} from "@/lib/work/db";
import { AttendanceEditor, RoadmapAdminActions } from "./actions-client";

type Search = { searchParams: Promise<{ companyId?: string }> };

export default async function AdminRoadmapPage({ searchParams }: Search) {
  const session = await readSession(siteConfig);
  if (!session || !isAdmin(session.email) || emailDomain(session.email) !== "xl.net")
    redirect("/login?redirect=%2Fadmin%2Froadmap");
  // Verified-staff check separated from the bounce so an xl.net Microsoft
  // session without mv gets the explainer plus both sign-ins, never a login
  // form it has already satisfied.
  if (!isVerifiedStaffProvider(session))
    return (
      <StaffVerifyNotice
        email={session.email}
        surface="The client-workspace console"
        redirectTo="/admin/roadmap"
      />
    );

  const { companyId } = await searchParams;
  const usage = await readTodayRoadmapUsage();
  const enabled = roadmapEnabled(process.env);

  if (companyId === "staff") {
    // Staff-lane detail. This branch MUST precede companyById: "staff" is
    // not a uuid, and an eq on the uuid id column would throw 22P02. All
    // three sections read the NULL-company_id lanes; no companies row
    // exists for xl.net by hard invariant.
    const [people, docs, submissions, submissionsTotal, attendance] =
      await Promise.all([
        listPeople({ companyId: null }),
        listGovernanceDocs(STAFF_GOVDOC_SCOPE),
        staffSubmissions(),
        countStaffSubmissions(),
        readAttendance({ companyId: null }),
      ]);
    return (
      <div className="space-y-8">
        <div>
          <Link href="/admin/roadmap" className="text-sm">
            ← All companies
          </Link>
          <h1 className="mt-2 text-2xl font-bold">
            XL.net{" "}
            <span className="text-sm font-normal text-faint">
              xl.net · staff lane
            </span>
          </h1>
        </div>

        <p className="text-sm text-faint">
          The staff directory is managed on{" "}
          <Link href="/roadmap/directory">/roadmap/directory</Link>.
        </p>

        {/* "staff" literal selects the NULL-lane staff_roadmap_state row in
            the dispatch route (branched before any uuid lookup there). */}
        <AttendanceEditor
          companyId="staff"
          workshop={attendance.workshop}
          cohort={attendance.cohort}
        />

        <section>
          <h2 className="text-lg font-semibold">
            Directory ({people.length})
          </h2>
          <table className="mt-2 w-full text-left text-sm">
            <thead>
              <tr className="text-faint">
                <th className="pr-4 font-normal">Name</th>
                <th className="pr-4 font-normal">Email</th>
                <th className="pr-4 font-normal">Phone</th>
                <th className="font-normal">Source</th>
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.id}>
                  <td className="pr-4">{p.name}</td>
                  <td className="pr-4">{p.email ?? "·"}</td>
                  <td className="pr-4">{p.phone ?? "·"}</td>
                  <td>{p.source}</td>
                </tr>
              ))}
              {people.length === 0 && (
                <tr>
                  <td colSpan={4} className="text-faint">
                    Empty.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        <section>
          <h2 className="text-lg font-semibold">
            Governance documents ({docs.length})
          </h2>
          <ul className="mt-2 space-y-1 text-sm">
            {docs.map((d) => (
              <li key={d.id}>
                {d.title}{" "}
                <span className="text-faint">
                  ({d.source === "upload"
                    ? d.fileName ?? "upload"
                    : d.source === "link"
                      ? d.linkUrl ?? "link"
                      : "Governance Builder"}
                  , added by {d.addedByEmail},{" "}
                  {/* Owner directive 2026-08-25 (the rest of the timezone
                      class): every stored date reads in the VIEWER's zone.
                      This is a server component, so the bare
                      toLocaleDateString that stood here resolved to the VM's
                      zone, i.e. raw UTC wearing no label, and a doc added at
                      9pm Chicago was filed under the NEXT day for the person
                      who added it. <LocalTime> is the only helper that
                      crosses a server boundary safely: its useState seed is
                      UTC-pinned, so the SSR string and the first client
                      string match byte for byte and the zone swap happens a
                      tick after hydration. exact() would not work here at
                      all - it formats in the RUNTIME zone on first render,
                      which on the VM is still UTC. Date-only on purpose:
                      this is a provenance parenthetical already carrying the
                      source and the adder's address, and a clock would be a
                      third fact nobody opened the console for. The closing
                      ")" stays OUTSIDE the element, because <LocalTime> owns
                      a <time dateTime> and punctuation inside a
                      machine-readable timestamp is not a timestamp. */}
                  <LocalTime iso={d.createdAt.toISOString()} />)
                </span>
              </li>
            ))}
            {docs.length === 0 && <li className="text-faint">None.</li>}
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold">
            Work submissions ({submissionsTotal})
          </h2>
          {submissionsTotal > submissions.length && (
            <p className="mt-1 text-xs text-faint">
              Showing the newest {submissions.length} rows; the full
              pipeline is on <Link href="/admin/work">/admin/work</Link>.
            </p>
          )}
          <table className="mt-2 w-full text-left text-sm">
            <thead>
              <tr className="text-faint">
                <th className="pr-4 font-normal">Title</th>
                <th className="pr-4 font-normal">Status</th>
                <th className="pr-4 font-normal">Submitter</th>
                <th className="font-normal">Created</th>
              </tr>
            </thead>
            <tbody>
              {submissions.map((s) => (
                <tr key={s.id}>
                  <td className="pr-4">{s.title}</td>
                  <td className="pr-4">{s.status}</td>
                  <td className="pr-4">{s.submitterEmail}</td>
                  {/* withTime here, date-only in the governance list above:
                      this cell sits under an audit "Created" header, and it
                      is the same fact /admin/work put a labelled clock on
                      last round, so the two consoles have to agree. Growth
                      is free - it is the last column of a w-full table, so
                      the post-mount swap pushes nothing. */}
                  <td>
                    <LocalTime iso={s.createdAt.toISOString()} withTime />
                  </td>
                </tr>
              ))}
              {submissions.length === 0 && (
                <tr>
                  <td colSpan={4} className="text-faint">
                    None.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-faint">
            Held and pending rows are reviewed, and published cards
            arranged, on <Link href="/admin/work">/admin/work</Link> as
            usual.
          </p>
        </section>
      </div>
    );
  }

  if (companyId) {
    const company = await companyById(companyId);
    if (!company)
      return (
        <div className="space-y-4">
          <h1 className="text-2xl font-bold">Roadmap company</h1>
          <p className="text-sm">No company with that id.</p>
          <Link href="/admin/roadmap">Back to the list</Link>
        </div>
      );
    const [admins, people, docs, submissions, attendance] = await Promise.all([
      companyAdminsDetail(company.id),
      listPeople({ companyId: company.id }),
      listGovernanceDocs({ companyId: company.id }),
      companySubmissions(company.id),
      readAttendance({ companyId: company.id }),
    ]);
    return (
      <div className="space-y-8">
        <div>
          <Link href="/admin/roadmap" className="text-sm">
            ← All companies
          </Link>
          <h1 className="mt-2 text-2xl font-bold">
            {company.name}{" "}
            <span className="text-sm font-normal text-faint">
              {company.domain} · {company.status}
            </span>
          </h1>
        </div>

        <RoadmapAdminActions
          company={{
            id: company.id,
            domain: company.domain,
            name: company.name,
            status: company.status,
          }}
          admins={admins.map((a) => ({
            userId: a.userId,
            email: a.email,
            grantedVia: a.grantedVia,
          }))}
        />

        <AttendanceEditor
          companyId={company.id}
          workshop={attendance.workshop}
          cohort={attendance.cohort}
        />

        <section>
          <h2 className="text-lg font-semibold">
            Directory ({people.length})
          </h2>
          <table className="mt-2 w-full text-left text-sm">
            <thead>
              <tr className="text-faint">
                <th className="pr-4 font-normal">Name</th>
                <th className="pr-4 font-normal">Email</th>
                <th className="pr-4 font-normal">Phone</th>
                <th className="font-normal">Source</th>
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.id}>
                  <td className="pr-4">{p.name}</td>
                  <td className="pr-4">{p.email ?? "·"}</td>
                  <td className="pr-4">{p.phone ?? "·"}</td>
                  <td>{p.source}</td>
                </tr>
              ))}
              {people.length === 0 && (
                <tr>
                  <td colSpan={4} className="text-faint">
                    Empty.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        <section>
          <h2 className="text-lg font-semibold">
            Governance documents ({docs.length})
          </h2>
          <ul className="mt-2 space-y-1 text-sm">
            {docs.map((d) => (
              <li key={d.id}>
                {d.title}{" "}
                <span className="text-faint">
                  ({d.source === "upload"
                    ? d.fileName ?? "upload"
                    : d.source === "link"
                      ? d.linkUrl ?? "link"
                      : "Governance Builder"}
                  , added by {d.addedByEmail},{" "}
                  {/* Twin of the staff branch above; the two must always
                      move together or one console's two halves disagree
                      about what day a doc was added. Reasoning in full
                      there. */}
                  <LocalTime iso={d.createdAt.toISOString()} />)
                </span>
              </li>
            ))}
            {docs.length === 0 && <li className="text-faint">None.</li>}
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold">
            Work submissions ({submissions.length})
          </h2>
          <table className="mt-2 w-full text-left text-sm">
            <thead>
              <tr className="text-faint">
                <th className="pr-4 font-normal">Title</th>
                <th className="pr-4 font-normal">Status</th>
                <th className="pr-4 font-normal">Submitter</th>
                <th className="font-normal">Created</th>
              </tr>
            </thead>
            <tbody>
              {submissions.map((s) => (
                <tr key={s.id}>
                  <td className="pr-4">{s.title}</td>
                  <td className="pr-4">{s.status}</td>
                  <td className="pr-4">{s.submitterEmail}</td>
                  {/* Twin of the staff branch above: same audit column,
                      same precision, moves with it. */}
                  <td>
                    <LocalTime iso={s.createdAt.toISOString()} withTime />
                  </td>
                </tr>
              ))}
              {submissions.length === 0 && (
                <tr>
                  <td colSpan={4} className="text-faint">
                    None.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-faint">
            Held and pending rows are reviewed, and published cards
            arranged, on <Link href="/admin/work">/admin/work</Link> as
            usual.
          </p>
        </section>
      </div>
    );
  }

  const [companies, requests, staffPeople, staffDocs, staffPublished] =
    await Promise.all([
      companiesOverview(),
      allPendingRequests(),
      countPeople({ companyId: null }),
      countGovernanceDocs(STAFF_GOVDOC_SCOPE),
      countStaffPublished(),
    ]);
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Roadmap companies</h1>
        <p className="mt-1 text-sm text-faint">
          Client workspaces on the AI Roadmap. Writes are{" "}
          {enabled ? "enabled" : "PAUSED (ROADMAP_ENABLED=0)"}. Today:{" "}
          {usage.panelRuns} client panel runs, {usage.brainCalls} brain calls
          (cap slice {ROADMAP_CAPS.brainCallsPerDayDefault} default),{" "}
          {usage.apolloCalls} Apollo calls.
        </p>
      </div>

      {requests.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold">
            Pending admin requests ({requests.length})
          </h2>
          <RoadmapAdminActions
            requests={requests.map((r) => ({
              id: r.id,
              requesterEmail: r.requesterEmail,
              companyName: r.companyName,
              companyDomain: r.companyDomain,
              createdAt: r.createdAt.toISOString(),
            }))}
          />
        </section>
      )}

      <section>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-faint">
              <th className="pr-4 font-normal">Company</th>
              <th className="pr-4 font-normal">Status</th>
              <th className="pr-4 font-normal">People</th>
              <th className="pr-4 font-normal">Docs</th>
              <th className="pr-4 font-normal">Published</th>
              <th className="pr-4 font-normal">Admins</th>
              <th className="pr-4 font-normal">Created by</th>
              <th className="font-normal">Created</th>
            </tr>
          </thead>
          <tbody>
            {/* Synthetic pinned staff-lane row: xl.net is never a companies
                row, so Admins / Created by / Created have nothing backing
                them and render the "·" placeholder. */}
            <tr>
              <td className="pr-4">
                <Link href="/admin/roadmap?companyId=staff">XL.net</Link>{" "}
                <span className="text-faint">xl.net</span>
              </td>
              <td className="pr-4">staff</td>
              <td className="pr-4">{staffPeople}</td>
              <td className="pr-4">{staffDocs}</td>
              <td className="pr-4">{staffPublished}</td>
              <td className="pr-4">·</td>
              <td className="pr-4">·</td>
              <td>·</td>
            </tr>
            {companies.map((c) => (
              <tr key={c.id}>
                <td className="pr-4">
                  <Link href={`/admin/roadmap?companyId=${c.id}`}>
                    {c.name}
                  </Link>{" "}
                  <span className="text-faint">{c.domain}</span>
                </td>
                <td className="pr-4">{c.status}</td>
                <td className="pr-4">{c.people}</td>
                <td className="pr-4">{c.docs}</td>
                <td className="pr-4">{c.published}</td>
                <td className="pr-4">{c.admins}</td>
                <td className="pr-4">{c.createdByEmail}</td>
                {/* Date-only: when a workspace was opened is a roster
                    fact, not an audit trail (the cell to its left is an
                    address, not a clock), and a clock in an 8-wide table is
                    noise. The synthetic xl.net row above keeps its literal
                    "·" - that lane is not a companies row and has no
                    createdAt to render. */}
                <td>
                  <LocalTime iso={c.createdAt.toISOString()} />
                </td>
              </tr>
            ))}
            {companies.length === 0 && (
              <tr>
                <td colSpan={8} className="text-faint">
                  No companies yet. The first client to click Set up workspace
                  on /roadmap appears here.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
