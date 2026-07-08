import { redirect } from "next/navigation";
import { getSession, isAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { pageVisits } from "@/lib/db/schema";
import { count, countDistinct, desc, gte, sql } from "drizzle-orm";
import { classifyReferrer, extractDomain, type TrafficSource } from "@/lib/seo/classify-referrer";

export const dynamic = "force-dynamic";

const WINDOW_DAYS = 30;
const OWN_HOSTS = ["ai.xl.net", "xl.net", "localhost"];

// First-party traffic dashboard over page_visits (middleware beacons).
// External datasets (Google Search Console, Semrush) are not wired up —
// adding them means credentialed ingestion jobs, tracked separately.
export default async function AdminSeoPage() {
  const session = await getSession();
  if (!session || !isAdmin(session.email)) redirect("/login");

  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000);

  let totals = { visits: 0, sessions: 0, visitors: 0 };
  let topPages: Array<{ path: string; visits: number; sessions: number }> = [];
  let daily: Array<{ day: string; visits: number }> = [];
  let sourceRows: Array<{
    referrer: string | null;
    utmSource: string | null;
    utmMedium: string | null;
  }> = [];
  let depthRows: Array<{ pages: number; sessions: number }> = [];

  try {
    [totals, topPages, daily, sourceRows, depthRows] = await Promise.all([
      db
        .select({
          visits: count(),
          sessions: countDistinct(pageVisits.sessionHash),
          visitors: countDistinct(pageVisits.ipAddress),
        })
        .from(pageVisits)
        .where(gte(pageVisits.createdAt, since))
        .then(([r]) => r),
      db
        .select({
          path: pageVisits.path,
          visits: count(),
          sessions: countDistinct(pageVisits.sessionHash),
        })
        .from(pageVisits)
        .where(gte(pageVisits.createdAt, since))
        .groupBy(pageVisits.path)
        .orderBy(desc(count()))
        .limit(25),
      db
        .select({
          day: sql<string>`TO_CHAR(${pageVisits.createdAt} AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD')`,
          visits: count(),
        })
        .from(pageVisits)
        .where(gte(pageVisits.createdAt, since))
        .groupBy(sql`1`)
        .orderBy(sql`1 DESC`)
        // a 30×24h window straddles 31 Chicago calendar dates
        .limit(WINDOW_DAYS + 1),
      db
        .select({
          referrer: pageVisits.referrer,
          utmSource: pageVisits.utmSource,
          utmMedium: pageVisits.utmMedium,
        })
        .from(pageVisits)
        .where(gte(pageVisits.createdAt, since)),
      db
        .select({
          pages: sql<number>`page_count::int`,
          sessions: sql<number>`COUNT(*)::int`,
        })
        .from(
          // raw sql params don't serialize Date objects — pass the ISO string
          sql`(SELECT session_hash, COUNT(DISTINCT path) AS page_count
               FROM page_visits WHERE created_at >= ${since.toISOString()}
               GROUP BY session_hash) s`
        )
        .groupBy(sql`page_count`)
        .orderBy(sql`page_count`),
    ]);
  } catch {
    // page_visits appears with the next migration run
  }

  // Classify traffic sources + referring domains in JS (mirrors
  // itsupportchicago's approach — the rules live in classify-referrer.ts)
  const sources = new Map<TrafficSource, number>();
  const domains = new Map<string, number>();
  for (const row of sourceRows) {
    const domain = extractDomain(row.referrer);
    const isOwn =
      !!domain && OWN_HOSTS.some((h) => domain === h || domain.endsWith(`.${h}`));
    // An internal navigation (referer on our own host) is not an external
    // source — drop the referrer so it classifies as "direct" instead of
    // inflating "referral".
    const cls = classifyReferrer(isOwn ? null : row.referrer, row);
    sources.set(cls, (sources.get(cls) ?? 0) + 1);
    if (domain && !isOwn) {
      domains.set(domain, (domains.get(domain) ?? 0) + 1);
    }
  }
  const sourceList = [...sources.entries()].sort((a, b) => b[1] - a[1]);
  const domainList = [...domains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  const singlePage = depthRows.find((d) => d.pages === 1)?.sessions ?? 0;
  const bounceRate = totals.sessions ? Math.round((singlePage / totals.sessions) * 100) : 0;
  const maxDaily = Math.max(1, ...daily.map((d) => d.visits));

  return (
    <div className="stack" style={{ gap: "var(--sp-8)" }}>
      <div className="row row--between flex-wrap">
        <h1 className="text-2xl font-bold">SEO &amp; Traffic</h1>
        <span className="text-sm text-dim">last {WINDOW_DAYS} days</span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Page views" value={totals.visits} />
        <Stat label="Sessions" value={totals.sessions} />
        <Stat label="Unique visitors" value={totals.visitors} />
        <Stat label="Bounce rate" value={`${bounceRate}%`} hint="single-page sessions" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section>
          <h2 className="sys-label">Traffic sources</h2>
          <div className="panel mt-3 stack" style={{ gap: "var(--sp-2)" }}>
            {sourceList.length === 0 && (
              <p className="text-dim text-sm">No visits recorded yet.</p>
            )}
            {sourceList.map(([source, n]) => (
              <div key={source} className="row row--between text-sm">
                <span className="badge">{source}</span>
                <span>
                  {n}{" "}
                  <span className="text-faint">
                    ({totals.visits ? Math.round((n / totals.visits) * 100) : 0}%)
                  </span>
                </span>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2 className="sys-label">Referring domains</h2>
          <div className="panel mt-3 stack" style={{ gap: "var(--sp-2)" }}>
            {domainList.length === 0 && (
              <p className="text-dim text-sm">No external referrers yet.</p>
            )}
            {domainList.map(([domain, n]) => (
              <div key={domain} className="row row--between text-sm">
                <span className="mono text-xs">{domain}</span>
                <span>{n}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section>
        <h2 className="sys-label">Daily page views</h2>
        <div className="panel mt-3 stack" style={{ gap: "var(--sp-1)" }}>
          {daily.length === 0 && <p className="text-dim text-sm">No visits recorded yet.</p>}
          {daily.map((d) => (
            <div key={d.day} className="row text-xs" style={{ gap: "var(--sp-3)" }}>
              <span className="mono text-faint" style={{ width: "6.5rem" }}>
                {d.day}
              </span>
              <span
                aria-hidden="true"
                style={{
                  display: "inline-block",
                  height: "0.6rem",
                  width: `${Math.max(2, (d.visits / maxDaily) * 100)}%`,
                  maxWidth: "70%",
                  background: "var(--xl-light-dim)",
                }}
              />
              <span>{d.visits}</span>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="sys-label">Top pages</h2>
        <div className="panel mt-3 overflow-x-auto" style={{ padding: 0 }}>
          <table className="table w-full text-sm">
            <thead>
              <tr>
                <th className="px-3 py-2 text-left">Path</th>
                <th className="px-3 py-2 text-right">Views</th>
                <th className="px-3 py-2 text-right">Sessions</th>
              </tr>
            </thead>
            <tbody>
              {topPages.length === 0 && (
                <tr>
                  <td className="px-3 py-3 text-dim" colSpan={3}>
                    No visits recorded yet.
                  </td>
                </tr>
              )}
              {topPages.map((p) => (
                <tr key={p.path}>
                  <td className="px-3 py-2 mono text-xs">{p.path}</td>
                  <td className="px-3 py-2 text-right">{p.visits}</td>
                  <td className="px-3 py-2 text-right">{p.sessions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="sys-label">Session depth</h2>
        <div className="panel mt-3 stack" style={{ gap: "var(--sp-2)" }}>
          {depthRows.length === 0 && (
            <p className="text-dim text-sm">No sessions recorded yet.</p>
          )}
          {depthRows.map((d) => (
            <div key={d.pages} className="row row--between text-sm">
              <span>
                {d.pages} page{d.pages === 1 ? "" : "s"}
              </span>
              <span>{d.sessions} sessions</span>
            </div>
          ))}
        </div>
      </section>

      <p className="text-xs text-faint">
        First-party data only. Google Search Console and Semrush integrations are not
        connected for ai.xl.net.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: number | string;
  hint?: string;
}) {
  return (
    <div className="panel stat">
      <span className="sys-label">{label}</span>
      <span className="text-3xl font-bold glow">{value}</span>
      {hint && <span className="text-xs text-faint">{hint}</span>}
    </div>
  );
}
