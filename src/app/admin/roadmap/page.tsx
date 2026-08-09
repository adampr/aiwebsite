// /admin/roadmap (§5.18): the global-admin console for client-company
// workspaces. Self-guarding server component with the PROVIDER-CHECKED
// predicate (requireGlobalAdmin semantics inline; bare isAdmin is forgeable
// via the Microsoft common-tenant lane and this console renders client
// data). List view = metadata allowlist (domain, name, status, counts,
// admin roster, last import) - never content columns; the ?companyId detail
// view shows the directory and doc titles because there the directory IS
// the thing being administered. ?companyId request params are legal ONLY
// under this guard.

export const dynamic = "force-dynamic";

import Link from "next/link";
import { redirect } from "next/navigation";
import { readSession } from "@aicompany/core/auth/session";
import { isAdmin } from "@aicompany/core/auth/guard";
import { siteConfig } from "site.config";
import { emailDomain, isRfpProvider } from "@/lib/rfp/access";
import { roadmapEnabled, ROADMAP_CAPS } from "@/lib/roadmap/config";
import {
  allPendingRequests,
  companiesOverview,
  companyAdminsDetail,
  companyById,
  listGovernanceDocs,
  listPeople,
  readTodayRoadmapUsage,
} from "@/lib/roadmap/db";
import { companySubmissions } from "@/lib/work/db";
import { RoadmapAdminActions } from "./actions-client";

type Search = { searchParams: Promise<{ companyId?: string }> };

export default async function AdminRoadmapPage({ searchParams }: Search) {
  const session = await readSession(siteConfig);
  if (
    !session ||
    !isAdmin(session.email) ||
    !isRfpProvider(session.provider) ||
    emailDomain(session.email) !== "xl.net"
  )
    redirect("/login");

  const { companyId } = await searchParams;
  const usage = await readTodayRoadmapUsage();
  const enabled = roadmapEnabled(process.env);

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
    const [admins, people, docs, submissions] = await Promise.all([
      companyAdminsDetail(company.id),
      listPeople({ companyId: company.id }),
      listGovernanceDocs(company.id),
      companySubmissions(company.id),
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
                  ({d.source === "upload" ? d.fileName ?? "upload" : "Governance Builder"}
                  , added by {d.addedByEmail},{" "}
                  {d.createdAt.toLocaleDateString("en-US")})
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
                  <td>{s.createdAt.toLocaleDateString("en-US")}</td>
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

  const [companies, requests] = await Promise.all([
    companiesOverview(),
    allPendingRequests(),
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
                <td>{c.createdAt.toLocaleDateString("en-US")}</td>
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
