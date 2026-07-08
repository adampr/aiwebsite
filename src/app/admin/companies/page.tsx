import { redirect } from "next/navigation";
import { getSession, isAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { pageVisits, ipOrgs } from "@/lib/db/schema";
import { count, countDistinct, desc, eq, max, sql } from "drizzle-orm";
import { fmtDate } from "@/lib/admin/format";

export const dynamic = "force-dynamic";

// Which organizations are reading the site: page_visits joined to the
// MaxMind IP→ASN cache, ISP/residential ASNs filtered out. Only as good as
// GeoLite2-ASN — corporate traffic behind consumer ISPs stays invisible.
export default async function AdminCompaniesPage() {
  const session = await getSession();
  if (!session || !isAdmin(session.email)) redirect("/login");

  let companies: Array<{
    orgName: string | null;
    visits: number;
    uniqueIps: number;
    lastVisit: Date | null;
  }> = [];
  const stats = { ipsCached: 0, identified: 0 };

  try {
    const [ipStats] = await db
      .select({
        ipsCached: count(),
        identified: sql<number>`COUNT(*) FILTER (WHERE ${ipOrgs.orgName} IS NOT NULL AND NOT ${ipOrgs.isIsp})::int`,
      })
      .from(ipOrgs);
    stats.ipsCached = ipStats.ipsCached;
    stats.identified = ipStats.identified;

    companies = await db
      .select({
        orgName: ipOrgs.orgName,
        visits: count(pageVisits.id),
        uniqueIps: countDistinct(pageVisits.ipAddress),
        lastVisit: max(pageVisits.createdAt),
      })
      .from(pageVisits)
      .innerJoin(ipOrgs, eq(pageVisits.ipAddress, ipOrgs.ipAddress))
      .where(sql`${ipOrgs.orgName} IS NOT NULL AND NOT ${ipOrgs.isIsp}`)
      .groupBy(ipOrgs.orgName)
      .orderBy(desc(max(pageVisits.createdAt)))
      .limit(200);
  } catch {
    // tables appear with the next migration run
  }

  return (
    <div className="stack" style={{ gap: "var(--sp-6)" }}>
      <h1 className="text-2xl font-bold">Companies</h1>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="panel stat">
          <span className="sys-label">Identified orgs</span>
          <span className="text-3xl font-bold glow">{companies.length}</span>
        </div>
        <div className="panel stat">
          <span className="sys-label">IPs resolved</span>
          <span className="text-3xl font-bold glow">{stats.ipsCached}</span>
        </div>
        <div className="panel stat">
          <span className="sys-label">Business IPs</span>
          <span className="text-3xl font-bold glow">{stats.identified}</span>
          <span className="text-xs text-faint">non-ISP, attributable</span>
        </div>
      </div>

      <div className="panel overflow-x-auto" style={{ padding: 0 }}>
        <table className="table w-full text-sm">
          <thead>
            <tr>
              <th className="px-3 py-2 text-left">Organization</th>
              <th className="px-3 py-2 text-right">Visits</th>
              <th className="px-3 py-2 text-right">Unique IPs</th>
              <th className="px-3 py-2 text-left">Last visit</th>
            </tr>
          </thead>
          <tbody>
            {companies.length === 0 && (
              <tr>
                <td className="px-3 py-3 text-dim" colSpan={4}>
                  No identified organizations yet — visits accumulate once tracking is
                  live and the GeoLite2-ASN database is in place.
                </td>
              </tr>
            )}
            {companies.map((c) => (
              <tr key={c.orgName}>
                <td className="px-3 py-2">{c.orgName}</td>
                <td className="px-3 py-2 text-right">{c.visits}</td>
                <td className="px-3 py-2 text-right">{c.uniqueIps}</td>
                <td className="px-3 py-2 text-dim whitespace-nowrap">{fmtDate(c.lastVisit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
