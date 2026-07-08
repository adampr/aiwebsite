import { redirect } from "next/navigation";
import { getSession, isAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { users, authLogs, pageVisits } from "@/lib/db/schema";
import { desc, count, gte, sql } from "drizzle-orm";
import {
  getBrainUsageTotals,
  getBrainUsageByModel,
  type UsageTotals,
  type UsageByModel,
} from "@/lib/brain-db";
import { fmtDate, fmtUsd } from "@/lib/admin/format";

export const dynamic = "force-dynamic";

export default async function AdminAnalyticsPage() {
  const session = await getSession();
  if (!session || !isAdmin(session.email)) redirect("/login");

  const stats = {
    totalUsers: 0,
    visits30d: 0,
    sessions30d: 0,
    recentLogins: [] as Array<{
      email: string;
      provider: string;
      createdAt: Date | null;
      success: boolean;
    }>,
    usage30d: { events: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 } as UsageTotals,
    usageByModel: [] as UsageByModel[],
  };

  // Each source degrades independently: brain tables exist only after
  // brain-api's first boot, page_visits only after this feature deploys.
  const since30d = new Date(Date.now() - 30 * 86_400_000);
  await Promise.all([
    (async () => {
      const [row] = await db.select({ count: count() }).from(users);
      stats.totalUsers = row.count;
    })().catch(() => {}),
    (async () => {
      const [row] = await db
        .select({
          visits: count(),
          sessions: sql<number>`COUNT(DISTINCT ${pageVisits.sessionHash})::int`,
        })
        .from(pageVisits)
        .where(gte(pageVisits.createdAt, since30d));
      stats.visits30d = row.visits;
      stats.sessions30d = row.sessions;
    })().catch(() => {}),
    (async () => {
      stats.recentLogins = await db
        .select({
          email: authLogs.email,
          provider: authLogs.authProvider,
          createdAt: authLogs.createdAt,
          success: authLogs.success,
        })
        .from(authLogs)
        .orderBy(desc(authLogs.createdAt))
        .limit(20);
    })().catch(() => {}),
    getBrainUsageTotals(30)
      .then((t) => {
        stats.usage30d = t;
      })
      .catch(() => {}),
    getBrainUsageByModel(30)
      .then((m) => {
        stats.usageByModel = m;
      })
      .catch(() => {}),
  ]);

  return (
    <div className="stack" style={{ gap: "var(--sp-8)" }}>
      <h1 className="text-2xl font-bold">Analytics</h1>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Signed-in users" value={String(stats.totalUsers)} />
        <StatCard label="Visits · 30d" value={String(stats.visits30d)} />
        <StatCard label="Sessions · 30d" value={String(stats.sessions30d)} />
        <StatCard
          label="Brain spend · 30d"
          value={fmtUsd(stats.usage30d.costUsd)}
          hint={`${stats.usage30d.events} calls · ${formatTokens(
            stats.usage30d.inputTokens + stats.usage30d.outputTokens
          )} tokens`}
        />
      </div>

      <section>
        <h2 className="sys-label">Brain usage by model · 30d</h2>
        <div className="panel mt-3 overflow-x-auto" style={{ padding: 0 }}>
          <table className="table w-full text-sm">
            <thead>
              <tr>
                <th className="px-3 py-2 text-left">Model</th>
                <th className="px-3 py-2 text-right">Calls</th>
                <th className="px-3 py-2 text-right">Input tok</th>
                <th className="px-3 py-2 text-right">Output tok</th>
                <th className="px-3 py-2 text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {stats.usageByModel.length === 0 && (
                <tr>
                  <td className="px-3 py-3 text-dim" colSpan={5}>
                    No usage recorded yet.
                  </td>
                </tr>
              )}
              {stats.usageByModel.map((m) => (
                <tr key={m.model}>
                  <td className="px-3 py-2 mono">{m.model}</td>
                  <td className="px-3 py-2 text-right">{m.events}</td>
                  <td className="px-3 py-2 text-right">{formatTokens(m.inputTokens)}</td>
                  <td className="px-3 py-2 text-right">{formatTokens(m.outputTokens)}</td>
                  <td className="px-3 py-2 text-right">{fmtUsd(m.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="sys-label">Recent sign-ins</h2>
        <div className="panel mt-3 overflow-x-auto" style={{ padding: 0 }}>
          <table className="table w-full text-sm">
            <thead>
              <tr>
                <th className="px-3 py-2 text-left">Email</th>
                <th className="px-3 py-2 text-left">Provider</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left">Time</th>
              </tr>
            </thead>
            <tbody>
              {stats.recentLogins.length === 0 && (
                <tr>
                  <td className="px-3 py-3 text-dim" colSpan={4}>
                    No sign-ins recorded yet.
                  </td>
                </tr>
              )}
              {stats.recentLogins.map((l, i) => (
                <tr key={i}>
                  <td className="px-3 py-2">{l.email}</td>
                  <td className="px-3 py-2">{l.provider}</td>
                  <td className="px-3 py-2">
                    <span className={l.success ? "badge badge--ok" : "badge badge--danger"}>
                      {l.success ? "OK" : "FAIL"}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-dim">{fmtDate(l.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
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

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
