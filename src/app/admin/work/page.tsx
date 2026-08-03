// /admin/work (§5.16): owner review of team work submissions. Self-guarding
// server component (the layout re-check is defense-in-depth). Lists every
// submission with its panel outcome; held rows expose Approve as-is, pending
// updates expose Approve/Reject (the swap gate: nothing replaces a live card
// without a click here), and every row exposes Delete (which is unpublish
// for published rows and ROLLBACK for published update rows).

import { redirect } from "next/navigation";
import { readSession } from "@aicompany/core/auth/session";
import { isAdmin } from "@aicompany/core/auth/guard";
import { siteConfig } from "site.config";
import { allSubmissions, submissionById } from "@/lib/work/db";
import {
  KIND_LABELS,
  workSubmissionsEnabled,
  type WorkKind,
} from "@/lib/work/config";
import { WorkAdminActions } from "./actions-client";

export const dynamic = "force-dynamic";

// Raw status tokens never render: pending_approval reads as a phrase.
const STATUS_CHIP: Record<string, string> = {
  pending_approval: "pending approval",
};

export default async function AdminWorkPage() {
  const session = await readSession(siteConfig);
  if (!session || !isAdmin(session.email)) redirect("/login");
  const rows = await allSubmissions(100);
  const byId = new Map(rows.map((r) => [r.id, r]));
  // Parents older than the 100-row window would otherwise render a false
  // "no longer published" (refutation finding, 2026-08-03).
  const missingParents = [
    ...new Set(
      rows
        .map((r) => r.parentId)
        .filter((p): p is string => !!p && !byId.has(p))
    ),
  ];
  for (const pid of missingParents) {
    const parent = await submissionById(pid);
    if (parent) byId.set(parent.id, parent);
  }
  const enabled = workSubmissionsEnabled(process.env);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Work submissions</h1>
        <p className="mt-1 text-sm text-faint">
          Team-built tools submitted for the /work page. The editorial panel
          publishes what passes its gate; held rows wait here for a decision,
          and updates that pass wait here for the swap approval.
          Intake is {enabled ? "enabled" : "PAUSED (WORK_SUBMISSIONS_ENABLED=0)"}.
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-faint">No submissions yet.</p>
      ) : (
        <div className="space-y-4">
          {rows.map((r) => {
            const isUpdate = !!r.parentId;
            const target = r.parentId ? byId.get(r.parentId) : undefined;
            const targetLive = !!target && target.status === "published";
            // Deleting a parent with an unresolved child is refused by the
            // route's 409 (copy surfaces via the actions island's msg
            // channel); the button stays enabled by design.
            const parentSuperseded =
              r.status === "published" &&
              !!target &&
              target.status === "superseded";
            return (
              <div
                key={r.id}
                id={`sub-${r.id}`}
                className="rounded-lg border border-[var(--xl-line,#333)] p-4 text-sm"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-medium">{r.title}</span>
                  <span className="rounded-full border px-2 text-xs">
                    {STATUS_CHIP[r.status] ?? r.status}
                  </span>
                  <span className="text-faint">
                    {KIND_LABELS[r.kind as WorkKind] ?? r.kind}
                  </span>
                  <span className="text-faint">{r.submitterEmail}</span>
                  <span className="text-faint">
                    {r.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                  </span>
                  {/* Provenance of INTAKE, not of the publish actor: a
                      crash-parked or once-held auto row published by the
                      click keeps the flag, and no stored bit records who
                      published. */}
                  {isUpdate && r.autoApprove && r.status === "published" && (
                    <span className="rounded-full border px-2 text-xs text-faint">
                      auto-approve lane
                    </span>
                  )}
                </div>
                {isUpdate && r.autoApprove && r.status === "pending_approval" && (
                  <p className="mt-2 text-xs text-faint">
                    {r.heldAt
                      ? "This admin web update was held earlier, so it parked for your click instead of auto-publishing (once-held rows always do). Approve publishes it now."
                      : "This admin web update is parked instead of auto-published (the submitter is no longer a listed admin, or the process restarted mid-finish). Approve publishes it now."}
                  </p>
                )}
                {isUpdate && r.status === "pending_approval" && (
                  <p className="mt-2 text-xs text-faint">
                    Proposed update to a live card:{" "}
                    {targetLive && target?.slug ? (
                      <a href={`/work#${target.slug}`} className="underline">
                        View the live card
                      </a>
                    ) : (
                      "the live card is no longer published"
                    )}
                    . Approve replaces the live card within 5 minutes. Reject
                    discards this proposal and emails the submitter.
                  </p>
                )}
                {isUpdate && r.status === "held" && (
                  <p className="mt-2 text-xs text-faint">
                    This is a proposed update; the live card stays up while it
                    waits.{" "}
                    {targetLive
                      ? "Approving publishes the draft in place of the live card."
                      : "Its target is no longer published, so it cannot be approved; delete it, or have the tool resubmitted as a new card."}
                  </p>
                )}
                {r.status === "superseded" && (
                  <p className="mt-2 text-xs text-faint">
                    Replaced by an approved update; the live card carries the
                    new version. Kept for rollback.
                  </p>
                )}
                {r.panelError && (
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs text-faint">
                    {r.panelError}
                  </pre>
                )}
                {r.cardJson && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs">
                      {isUpdate && r.status !== "published"
                        ? "Proposed card JSON"
                        : "Card JSON"}
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
                  isUpdate={isUpdate}
                  targetLive={targetLive}
                  parentSuperseded={parentSuperseded}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
