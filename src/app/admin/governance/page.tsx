// /admin/governance (ARCHITECTURE.md §5.6 + §5.12 "Admin review console"):
// host-owned, read-only review of AI Governance builder usage by user.
// Self-guarding server component like every module admin page (the layout
// re-check is defense-in-depth). Direct DB reads via admin-db.ts; no API
// route, no client JS. Every data source degrades independently and the
// three states (no data / feature disabled with cause / source unavailable)
// never look identical, per the module convention.
import { redirect } from "next/navigation";
import { readSession } from "@aicompany/core/auth/session";
import { isAdmin } from "@aicompany/core/auth/guard";
import { fmtDate } from "@aicompany/core/admin/format";
import { siteConfig } from "site.config";
import {
  ADMIN_GOV_COUNTERS_NOTE,
  ADMIN_GOV_POSTURE,
  ADMIN_GOV_SUBLINE,
  adminProjectsQuery,
  adminUsageQuery,
  adminUsersQuery,
  adminVisitsQuery,
  KIND_SHORT,
  STATUS_BADGE_VARIANT,
  statusLabel,
} from "@/lib/governance/admin-db";
import {
  deletesAt,
  monthTavilyCalls,
  readTodayUsage,
} from "@/lib/governance/db";
import { isBudgetExemptEmail } from "@/lib/governance/budget";
import type { GovernanceKind, ProjectStatus } from "@/lib/governance/types";

export const dynamic = "force-dynamic";

const PROJECTS_LIMIT = 100;

// Mirrors the module's private trackingDisabledCause (admin/pages/
// analytics.tsx, not exported; the submodule is do-not-modify) so the two
// consoles report the disabled state identically.
function trackingDisabledCause(): string | null {
  if (!siteConfig.tracking.enabled) return "tracking.enabled is false";
  if (!process.env.INTERNAL_TRACK_SECRET) return "INTERNAL_TRACK_SECRET unset";
  if (!siteConfig.privacy.policyUrl) return "privacy.policyUrl missing";
  return null;
}

const CSS = `
.govadm { display: flex; flex-direction: column; gap: 1.5rem; }
.govadm h1 { font-family: var(--site-font-display, inherit); font-size: 1.5rem; margin: 0; }
.govadm-sub { font-size: 0.875rem; color: var(--site-text-muted, #737373); margin: 0.25rem 0 0; max-width: 46rem; }
.govadm-label { font-size: 0.75rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--site-text-muted, #737373); margin: 0 0 0.5rem; }
.govadm-panel { border: 1px solid var(--site-line, #d4d4d4); border-radius: var(--site-radius-m, 8px); background: var(--site-surface, transparent); }
.govadm-note { font-size: 0.875rem; color: var(--site-text-muted, #737373); padding: 0.75rem 1rem; margin: 0; }
.govadm-note--warn { color: var(--site-warning, #b45309); }
.govadm-muted { color: var(--site-text-muted, #737373); }
.govadm-mono { font-family: var(--site-font-mono, ui-monospace, monospace); }
.govadm-cards { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); }
.govadm-stat { display: flex; flex-direction: column; gap: 0.25rem; padding: 1rem; }
.govadm-stat-value { font-size: 1.875rem; font-weight: 700; }
.govadm-stat-hint { font-size: 0.75rem; color: var(--site-text-muted, #737373); }
.govadm-tablewrap { overflow-x: auto; }
.govadm-table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
.govadm-table th { text-align: left; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--site-text-muted, #737373); padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--site-line, #d4d4d4); }
.govadm-table td { padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--site-line, #d4d4d4); vertical-align: top; }
.govadm-table tr:last-child td { border-bottom: none; }
.govadm-table .govadm-num { text-align: right; }
.govadm-badge { display: inline-block; font-size: 0.75rem; padding: 0.125rem 0.5rem; border: 1px solid var(--site-line, #d4d4d4); border-radius: 999px; white-space: nowrap; }
.govadm-badge--ok { color: var(--site-success, #15803d); border-color: var(--site-success, #15803d); }
.govadm-badge--warn { color: var(--site-warning, #b45309); border-color: var(--site-warning, #b45309); }
.govadm-badge--err { color: var(--site-error, #b91c1c); border-color: var(--site-error, #b91c1c); }
.govadm-chip { display: inline-block; font-size: 0.6875rem; padding: 0 0.375rem; margin-left: 0.375rem; border: 1px solid var(--site-line, #d4d4d4); border-radius: 999px; color: var(--site-text-muted, #737373); white-space: nowrap; }
.govadm-chip--err { color: var(--site-error, #b91c1c); border-color: var(--site-error, #b91c1c); }
.govadm-warn { color: var(--site-warning, #b45309); }
@media (max-width: 639px) {
  .govadm-table thead { display: none; }
  .govadm-table, .govadm-table tbody, .govadm-table tr, .govadm-table td { display: block; width: 100%; }
  .govadm-table tr { padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--site-line, #d4d4d4); }
  .govadm-table tr:last-child { border-bottom: none; }
  .govadm-table td { padding: 0.125rem 0; border-bottom: none; }
  .govadm-table .govadm-num { text-align: left; }
  .govadm-table td[data-label]::before { content: attr(data-label); display: block; font-size: 0.6875rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--site-text-muted, #737373); }
}
`;

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint: string;
}) {
  return (
    <div className="govadm-panel govadm-stat">
      <span className="govadm-stat-hint">{label}</span>
      <span className="govadm-stat-value">{value}</span>
      <span className="govadm-stat-hint">{hint}</span>
    </div>
  );
}

// fmtDate renders null as a dash glyph; the host copy ban wants n/a instead.
function ts(value: string | Date | null | undefined, tz: string): string {
  return value ? fmtDate(value, tz) : "n/a";
}

function dateOnly(value: string | Date | null | undefined, tz: string): string {
  if (!value) return "n/a";
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString("en-US", {
    timeZone: tz,
    month: "short",
    day: "numeric",
  });
}

// Countdown derived from the canonical deletesAt() so a RETENTION_DAYS
// change can never fork the admin display from the user-facing promise.
function deleteCountdown(lastActivityAt: string | Date): {
  text: string;
  warn: boolean;
} {
  const at = Date.parse(deletesAt(new Date(lastActivityAt)));
  const days = Math.ceil((at - Date.now()) / 86_400_000);
  if (days <= 0) return { text: "sweeping", warn: true };
  return { text: `in ${days}d`, warn: days <= 7 };
}

function kindLabel(kind: string): string {
  return KIND_SHORT[kind as GovernanceKind] ?? kind;
}

function statusVariant(status: string): string {
  const v = STATUS_BADGE_VARIANT[status as ProjectStatus] ?? "neutral";
  return v === "neutral" ? "govadm-badge" : `govadm-badge govadm-badge--${v}`;
}

export default async function Page() {
  const session = await readSession(siteConfig);
  if (!session || !isAdmin(session.email)) redirect("/login");

  const tz = siteConfig.site.timezone;
  const trackingOff = trackingDisabledCause();

  // null = source unavailable (query threw); values (even empty) = healthy.
  const [users, projects, usage, todayUsage, monthTavily, visits] =
    await Promise.all([
      adminUsersQuery().catch(() => null),
      adminProjectsQuery(PROJECTS_LIMIT).catch(() => null),
      adminUsageQuery().catch(() => null),
      readTodayUsage().catch(() => null),
      monthTavilyCalls().catch(() => null),
      trackingOff
        ? Promise.resolve(null)
        : adminVisitsQuery()
            .then((rows) => rows[0] ?? { views: 0, sessions: 0 })
            .catch(() => null),
    ]);

  const projectsOnFile = users ? users.reduce((n, u) => n + u.projects, 0) : null;
  const failedTurns = projects
    ? projects.filter((p) => p.lastTurnFailed).length
    : null;

  return (
    <div className="govadm">
      <style>{CSS}</style>
      <div>
        <h1>Governance</h1>
        <p className="govadm-sub">{ADMIN_GOV_SUBLINE}</p>
      </div>

      <div className="govadm-cards">
        <StatCard
          label="Projects on file"
          value={projectsOnFile ?? "n/a"}
          hint="deletes 30 days after the user's last activity"
        />
        <StatCard
          label="Owners"
          value={users ? users.length : "n/a"}
          hint="users with a project on file"
        />
        <StatCard
          label="Research runs today"
          value={todayUsage ? todayUsage.researchRuns : "n/a"}
          hint={
            todayUsage
              ? `tavily ${todayUsage.tavilyCalls} · brain ${todayUsage.brainCalls} today`
              : "usage counters unavailable"
          }
        />
        <StatCard
          label="Tavily this month"
          value={monthTavily ?? "n/a"}
          hint="monthly budget counter"
        />
        <StatCard
          label="Failed turns"
          value={failedTurns ?? "n/a"}
          hint="last turn errored, the user may be stuck"
        />
        <StatCard
          label="Page views · 30d"
          value={trackingOff ? "off" : visits ? visits.views : "n/a"}
          hint={
            trackingOff
              ? `tracking off: ${trackingOff}`
              : visits
                ? `${visits.sessions} sessions · not tied to users`
                : "page_visits unavailable"
          }
        />
      </div>

      <section>
        <h2 className="govadm-label">By user</h2>
        <div className="govadm-panel govadm-tablewrap">
          {users === null ? (
            <p className="govadm-note govadm-note--warn">
              User rollup unavailable, the site database did not answer.
            </p>
          ) : users.length === 0 ? (
            <p className="govadm-note">
              No users have a project on file right now. Users drop off this
              list when their last project deletes.
            </p>
          ) : (
            <table className="govadm-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th className="govadm-num">Projects</th>
                  <th className="govadm-num">Done</th>
                  <th>Last activity</th>
                  <th>First project</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.userId}>
                    <td data-label="User">
                      <span className="govadm-mono">{u.email}</span>
                      {isBudgetExemptEmail(u.email) ? (
                        <span className="govadm-chip">staff</span>
                      ) : null}
                      {u.displayName ? (
                        <span
                          className="govadm-muted"
                          style={{ display: "block", fontSize: "0.75rem" }}
                        >
                          {u.displayName}
                        </span>
                      ) : null}
                    </td>
                    <td data-label="Projects" className="govadm-num">
                      {u.projects}
                    </td>
                    <td data-label="Done" className="govadm-num">
                      {u.done}
                    </td>
                    <td data-label="Last activity">
                      {ts(u.lastActivityAt, tz)}
                    </td>
                    <td data-label="First project">
                      {dateOnly(u.firstCreatedAt, tz)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section>
        <h2 className="govadm-label">Projects</h2>
        {projects && projects.length === PROJECTS_LIMIT ? (
          <p className="govadm-note">
            Showing the {PROJECTS_LIMIT} most recently active projects.
          </p>
        ) : null}
        <div className="govadm-panel govadm-tablewrap">
          {projects === null ? (
            <p className="govadm-note govadm-note--warn">
              Projects unavailable, the site database did not answer.
            </p>
          ) : projects.length === 0 ? (
            <p className="govadm-note">
              {`No projects on file. New projects appear here the moment they are created and leave 30 days after the user's last activity.`}
            </p>
          ) : (
            <table className="govadm-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Kind</th>
                  <th>Domain</th>
                  <th>Status</th>
                  <th className="govadm-num">Answers</th>
                  <th>Last activity</th>
                  <th>Deletes</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p) => {
                  const del = deleteCountdown(p.lastActivityAt);
                  return (
                    <tr key={p.id}>
                      <td data-label="User" className="govadm-mono">
                        {p.email}
                      </td>
                      <td data-label="Kind">{kindLabel(p.kind)}</td>
                      <td data-label="Domain" className="govadm-mono">
                        {p.domain}
                      </td>
                      <td data-label="Status">
                        <span className={statusVariant(p.status)}>
                          {statusLabel(p.status)}
                        </span>
                        {p.turnRunning || p.researchAlive ? (
                          <span className="govadm-chip">live</span>
                        ) : null}
                        {p.lastTurnFailed ? (
                          <span className="govadm-chip govadm-chip--err">
                            err
                          </span>
                        ) : null}
                        {p.flagged ? (
                          <span className="govadm-chip">flag</span>
                        ) : null}
                      </td>
                      <td data-label="Answers" className="govadm-num">
                        {p.answersCount}
                      </td>
                      <td data-label="Last activity">
                        {ts(p.lastActivityAt, tz)}
                      </td>
                      <td data-label="Deletes">
                        <span className={del.warn ? "govadm-warn" : "govadm-muted"}>
                          {del.text}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section>
        <h2 className="govadm-label">Daily counters · last 14 days</h2>
        <div className="govadm-panel govadm-tablewrap">
          {usage === null ? (
            <p className="govadm-note govadm-note--warn">
              Usage counters unavailable, the site database did not answer.
            </p>
          ) : usage.length === 0 ? (
            <p className="govadm-note">
              No counter rows yet. Rows appear on the first research run or
              drafting turn of a day.
            </p>
          ) : (
            <table className="govadm-table">
              <thead>
                <tr>
                  <th>Day</th>
                  <th className="govadm-num">Research runs</th>
                  <th className="govadm-num">Tavily calls</th>
                  <th className="govadm-num">Brain calls</th>
                </tr>
              </thead>
              <tbody>
                {usage.map((row) => (
                  <tr key={row.day}>
                    <td data-label="Day" className="govadm-mono">
                      {row.day}
                    </td>
                    <td data-label="Research runs" className="govadm-num">
                      {row.researchRuns}
                    </td>
                    <td data-label="Tavily calls" className="govadm-num">
                      {row.tavilyCalls}
                    </td>
                    <td data-label="Brain calls" className="govadm-num">
                      {row.brainCalls}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <p className="govadm-note" style={{ paddingLeft: 0 }}>
          {ADMIN_GOV_COUNTERS_NOTE}
        </p>
      </section>

      <p className="govadm-note" style={{ paddingLeft: 0 }}>
        {ADMIN_GOV_POSTURE}
      </p>
    </div>
  );
}
