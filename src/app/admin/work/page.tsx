// /admin/work (§5.16): owner review of team work submissions. Self-guarding
// server component (the layout re-check is defense-in-depth). Lists every
// submission with its panel outcome; held rows expose Approve as-is, and
// every row exposes Delete (which is also unpublish for published rows).

import { redirect } from "next/navigation";
import { readSession } from "@aicompany/core/auth/session";
import { isAdmin } from "@aicompany/core/auth/guard";
import { siteConfig } from "site.config";
import { allSubmissions } from "@/lib/work/db";
import { workSubmissionsEnabled } from "@/lib/work/config";
import { WorkAdminActions } from "./actions-client";

export const dynamic = "force-dynamic";

export default async function AdminWorkPage() {
  const session = await readSession(siteConfig);
  if (!session || !isAdmin(session.email)) redirect("/login");
  const rows = await allSubmissions(100);
  const enabled = workSubmissionsEnabled(process.env);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Work submissions</h1>
        <p className="mt-1 text-sm text-faint">
          Team-built tools submitted for the /work page. The editorial panel
          publishes what passes its gate; held rows wait here for a decision.
          Intake is {enabled ? "enabled" : "PAUSED (WORK_SUBMISSIONS_ENABLED=0)"}.
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-faint">No submissions yet.</p>
      ) : (
        <div className="space-y-4">
          {rows.map((r) => (
            <div
              key={r.id}
              className="rounded-lg border border-[var(--xl-line,#333)] p-4 text-sm"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-medium">{r.title}</span>
                <span className="rounded-full border px-2 text-xs">
                  {r.status}
                </span>
                <span className="text-faint">{r.kind}</span>
                <span className="text-faint">{r.submitterEmail}</span>
                <span className="text-faint">
                  {r.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                </span>
              </div>
              {r.panelError && (
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs text-faint">
                  {r.panelError}
                </pre>
              )}
              {r.cardJson && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs">
                    Card JSON
                  </summary>
                  <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap text-xs text-faint">
                    {JSON.stringify(JSON.parse(r.cardJson), null, 2)}
                  </pre>
                </details>
              )}
              <WorkAdminActions
                id={r.id}
                status={r.status}
                slug={r.slug}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
