// /rfp/admin/activity — the activity log (§5.17). Admin only.
//
// Shape, never content. Every row is an id, a key, a count or an outcome, so
// this table can be read without exposing anything the RFPs themselves hold.

import type { Metadata } from "next";
import { requireRfpPage } from "@/lib/rfp/access";
import { recentActivity } from "@/lib/rfp/db";
import { LocalTime } from "@/components/local-time";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  title: "RFP activity",
  robots: { index: false, follow: false },
};

export default async function ActivityPage() {
  const gate = await requireRfpPage("/rfp/admin/activity");
  if (!gate.ok) return null;

  if (!gate.user.admin) {
    return (
      <div className="panel panel--raised">
        <p>The activity log is an XL.net admin view.</p>
      </div>
    );
  }

  const rows = await recentActivity(gate.user, 200);

  return (
    <div className="space-y-6">
      <div>
        <span className="sys-label">Activity</span>
        <p className="mt-4 max-w-2xl">
          Everything that happened around RFPs, newest first. Records what was
          done and to what, never the contents: no RFP text, no draft prose, no
          money.
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="panel">
          <p className="text-faint">Nothing recorded yet.</p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="table table--stack">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Who</th>
                  <th>Action</th>
                  <th>Subject</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Time" className="text-faint text-xs">
                      <LocalTime iso={r.at.toISOString()} withTime />
                    </td>
                    <td data-label="Who" className="mono text-xs">
                      {r.actorEmail}
                      {r.actorAdmin && (
                        <>
                          {" "}
                          <span className="badge">admin</span>
                        </>
                      )}
                    </td>
                    <td data-label="Action" className="mono text-xs">
                      {r.action}
                      {r.outcome !== "ok" && (
                        <>
                          {" "}
                          <span className="badge badge--warn">{r.outcome}</span>
                        </>
                      )}
                    </td>
                    <td data-label="Subject" className="mono text-xs text-faint">
                      {r.subjectKind ?? ""}
                      {r.subjectId ? ` ${r.subjectId.slice(0, 8)}` : ""}
                    </td>
                    <td data-label="Detail" className="text-xs text-faint">
                      {r.metaJson ?? ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-faint">
            Showing the most recent {rows.length}.
          </p>
        </>
      )}
    </div>
  );
}
