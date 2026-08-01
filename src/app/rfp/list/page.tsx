// /rfp/list — your RFPs. Admins additionally see everyone's (§5.17).

import type { Metadata } from "next";
import Link from "next/link";
import { requireRfpPage } from "@/lib/rfp/access";
import { listAllDocuments, listMyDocuments } from "@/lib/rfp/db";
import { logRfpActivity } from "@/lib/rfp/activity";
import { when } from "@/lib/rfp/time";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  title: "RFPs",
  robots: { index: false, follow: false },
};

export default async function RfpListPage() {
  const gate = await requireRfpPage("/rfp/list");
  if (!gate.ok) return null;
  const user = gate.user;

  const mine = await listMyDocuments(user);
  const all = user.admin ? await listAllDocuments(user) : [];
  const others = all.filter((d) => d.ownerEmail !== user.email.toLowerCase());

  // An admin reading everyone's work is a thing the log should show.
  if (user.admin && others.length)
    await logRfpActivity({
      actorEmail: user.email,
      actorAdmin: true,
      action: "admin.view_all",
      meta: { visible: all.length },
    });

  return (
    <div className="space-y-12">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <span className="sys-label">Your RFPs</span>
          <p className="mt-3 text-sm text-faint">
            Everything you are working on. Open one to draft, edit, and check
            it against the rules.
          </p>
        </div>
        <Link href="/rfp/new" className="btn btn--primary">
          Start an RFP
        </Link>
      </div>

      {mine.length === 0 ? (
        <div className="panel">
          <p className="text-faint">
            Nothing here yet. Start one and it lands in this list.
          </p>
        </div>
      ) : (
        <DocTable rows={mine} />
      )}

      {user.admin && (
        <section>
          <h2 className="doc-h">Everyone else</h2>
          <p className="mt-2 text-sm text-faint">
            Admin view. {others.length} RFP{others.length === 1 ? "" : "s"}{" "}
            owned by other people, current and past.
          </p>
          {others.length === 0 ? (
            <div className="panel mt-4">
              <p className="text-faint">Nobody else has started one.</p>
            </div>
          ) : (
            <div className="mt-4">
              <DocTable rows={others} showOwner />
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function DocTable({
  rows,
  showOwner = false,
}: {
  rows: Awaited<ReturnType<typeof listMyDocuments>>;
  showOwner?: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="table table--stack">
        <thead>
          <tr>
            <th>RFP</th>
            <th>Client</th>
            {showOwner && <th>Owner</th>}
            <th>Status</th>
            <th>Last touched</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id}>
              <td data-label="RFP">
                <Link href={`/rfp/r/${d.id}`}>{d.title}</Link>
                {d.injectionFlagged && (
                  <>
                    {" "}
                    <span className="badge badge--warn">Check the source</span>
                  </>
                )}
              </td>
              <td data-label="Client">{d.clientName ?? "Not named yet"}</td>
              {showOwner && (
                <td data-label="Owner" className="mono text-xs">
                  {d.ownerEmail}
                </td>
              )}
              <td data-label="Status">
                <span
                  className={`badge${d.status === "read_failed" ? " badge--danger" : ""}`}
                >
                  {d.status === "extracted"
                    ? "Read"
                    : d.status === "reading" || d.status === "new"
                      ? "Reading"
                      : d.status === "read_failed"
                        ? "Could not read"
                        : d.status}
                </span>
              </td>
              <td data-label="Last touched" className="text-faint">
                {when(d.updatedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
