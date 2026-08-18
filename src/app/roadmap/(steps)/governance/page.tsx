// Roadmap step 1: AI Governance (§5.18). Admins upload documents, link a
// policy where it already lives (owner directive 2026-08-18; the stored
// href renders as an external anchor, so only parseCheckableUrl output ever
// reaches link_url), or attach their own Governance Builder projects;
// MEMBERS may also attach their OWN projects (attach is member-actionable;
// upload, link and remove are admin-only).
// The gate is called here as well as in the (steps) layout - a denied
// render returns null and the layout's denial screen is what the visitor
// sees. All data is fetched with the principal's company id or the staff
// lane, never a client-supplied one.
//
// STAFF BRANCH (owner ruling 2026-08-18, the Noel report): staff no longer
// redirect to the public builder - they get a READ-ONLY view of the XL.net
// staff-lane document (company_governance_docs, company_id NULL): on file
// (readable/downloadable), in draft (a live xl.net builder project,
// metadata-only signal), or nothing yet. Non-admin staff see no Upload, no
// Attach, no Create, and no builder link: creation and filing stay with
// XL.net global admins, who get the company-page affordances here operating
// on the staff lane (writes re-derive requireGlobalAdmin in docs-gate.ts;
// globalAdmin from readStaffPage selects UI affordances only).

import type { Metadata } from "next";
import Link from "next/link";
import { readStaffPage, requireRoadmapPage } from "@/lib/roadmap/access";
import {
  STAFF_GOVDOC_SCOPE,
  listGovernanceDocs,
  type GovDocRow,
} from "@/lib/roadmap/db";
import { staffGovernanceDraftQuery } from "@/lib/governance/admin-db";
import { listOwnedProjects } from "@/lib/governance/db";
import { fmtDate } from "@/components/roadmap/dates";
import {
  AttachProjectButton,
  LinkDocCard,
  RemoveDocButton,
  UploadDocCard,
} from "./gov-islands";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "AI Governance · Your AI Roadmap",
  robots: { index: false, follow: false },
};

const KIND_TITLES: Record<string, string> = {
  usage_policy: "AI Acceptable Use Policy (AUP)",
  nist_ai_rmf: "NIST AI RMF Alignment",
  eu_ai_act: "EU AI Act Readiness",
  iso_42001: "ISO 42001 Alignment",
};

const faint = { color: "var(--xl-text-faint)" } as const;

/** The on-file list, one markup for both lanes (only the admin lever
 * differs). */
function OnFileList({
  docs,
  emptyLine,
  canRemove,
}: {
  docs: GovDocRow[];
  emptyLine: string;
  canRemove: boolean;
}) {
  return (
    <section>
      <span className="sys-label">On File</span>
      {docs.length === 0 ? (
        <p className="mt-4 text-sm" style={faint}>
          {emptyLine}
        </p>
      ) : (
        <ul className="mt-4 space-y-4">
          {docs.map((doc) => (
            <li key={doc.id} className="panel">
              <div className="flex flex-wrap items-center gap-4">
                <span className="badge badge--light">
                  {doc.source === "upload"
                    ? "Upload"
                    : doc.source === "link"
                      ? "Link"
                      : "Builder"}
                </span>
                <h2 className="text-lg">{doc.title}</h2>
              </div>
              <p className="mono mt-3 text-xs" style={faint}>
                added by {doc.addedByEmail} · {fmtDate(doc.createdAt)}
              </p>
              {/* A link row shows its bare target so a reader can see where
                  it goes before clicking. The href is safe to render by the
                  schema invariant: only a parseCheckableUrl-validated
                  http/https URL is ever stored in link_url. */}
              {doc.linkUrl && (
                <p className="mono mt-1 break-all text-xs" style={faint}>
                  {doc.linkUrl}
                </p>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-4">
                {doc.source === "link" && doc.linkUrl ? (
                  <a
                    href={doc.linkUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn--text no-underline"
                  >
                    Open the policy <span aria-hidden="true">→</span>
                  </a>
                ) : (
                  <a
                    href={`/api/roadmap/docs/${doc.id}`}
                    className="btn btn--text no-underline"
                  >
                    Download
                  </a>
                )}
                {canRemove && <RemoveDocButton docId={doc.id} />}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The staff lane. Read-only for staff; global admins additionally file,
 * attach and remove on this lane. */
async function StaffGovernance({
  userId,
  globalAdmin,
}: {
  userId: string;
  globalAdmin: boolean;
}) {
  const [docs, draftRows, projects] = await Promise.all([
    listGovernanceDocs(STAFF_GOVDOC_SCOPE),
    staffGovernanceDraftQuery(),
    // Non-admins get no Attach panel, so their own projects are never read.
    globalAdmin ? listOwnedProjects(userId) : Promise.resolve([]),
  ]);
  const onFile = docs.length >= 1;
  const draft = !onFile && (draftRows[0]?.n ?? 0) >= 1;
  const attachedProjectIds = new Set(
    docs.map((d) => d.governanceProjectId).filter(Boolean)
  );

  return (
    <div className="space-y-12">
      <section>
        <span className="sys-label">Step 01 · AI Governance</span>
        <h1 className="mt-4">XL.net&apos;s AI governance document</h1>
        <p className="mt-4 max-w-3xl text-sm">
          The document that governs how XL.net itself uses AI, on file where
          every staff member can read it. An XL.net global admin creates and
          files it.
        </p>
        <p className="mono mt-4 text-xs" style={faint}>
          {onFile
            ? "On file."
            : draft
              ? "In draft in the Governance Builder. It will appear here once an XL.net admin files it."
              : "Nothing on file yet."}
        </p>
      </section>

      {globalAdmin && (
        <section className="grid gap-6 md:grid-cols-3">
          <div className="panel">
            <span className="sys-label">Upload · Link</span>
            <h2 className="mt-4 text-lg">Upload or link a document</h2>
            <p className="mt-3 text-sm">
              Already have the policy? Put the file itself on record for
              XL.net staff.
            </p>
            <UploadDocCard />
            <div className="mt-6 border-t border-[var(--xl-line)] pt-4">
              <p className="text-sm">
                Or link to the policy where it already lives. Staff open it
                there; a sign-in wall is fine.
              </p>
              <LinkDocCard />
            </div>
          </div>

          <div className="panel">
            <span className="sys-label">Attach</span>
            <h2 className="mt-4 text-lg">
              Pick from your Governance Builder projects
            </h2>
            {projects.length === 0 ? (
              <p className="mt-3 text-sm">
                You have no Governance Builder projects yet.{" "}
                <Link href="/governance">
                  Create one in the Governance Builder
                </Link>{" "}
                and attach it here.
              </p>
            ) : (
              <ul className="mt-4 space-y-4">
                {projects.map((proj) => (
                  <li
                    key={proj.id}
                    className="border-t border-[var(--xl-line)] pt-3"
                  >
                    <div className="text-sm">
                      {KIND_TITLES[proj.kind] ?? "AI Governance Document"}
                    </div>
                    <div className="mono mt-1 text-xs" style={faint}>
                      {proj.domain} · last activity{" "}
                      {fmtDate(proj.lastActivityAt)}
                    </div>
                    <div className="mt-2">
                      <AttachProjectButton
                        projectId={proj.id}
                        attached={attachedProjectIds.has(proj.id)}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-4 text-xs" style={faint}>
              Attaching makes a copy for the staff file: this copy stays here
              and is not deleted after 30 days. Your project itself keeps its
              normal 30-day lifecycle.
            </p>
          </div>

          <div className="panel">
            <span className="sys-label">Create</span>
            <h2 className="mt-4 text-lg">Create one now</h2>
            <p className="mt-3 text-sm">
              No policy yet? The Governance Builder interviews you one
              question at a time and drafts it with you.
            </p>
            <Link href="/governance" className="btn btn--text mt-4 no-underline">
              Open the Governance Builder <span aria-hidden="true">→</span>
            </Link>
          </div>
        </section>
      )}

      <OnFileList
        docs={docs}
        emptyLine={
          globalAdmin
            ? "Nothing on file yet. The step completes the moment the first document or link lands here."
            : "Nothing on file yet. It will appear here the moment an XL.net admin files it."
        }
        canRemove={globalAdmin}
      />
    </div>
  );
}

export default async function RoadmapGovernancePage() {
  // Staff lane (§5.18 staff governance): a real branch, never a redirect -
  // STAFF_STEP_HREFS.governance points at THIS page, so a redirect would
  // loop, and returning null for staff renders the documented blank shell.
  const staff = await readStaffPage();
  if (staff) {
    return (
      <StaffGovernance userId={staff.userId} globalAdmin={staff.globalAdmin} />
    );
  }
  const gate = await requireRoadmapPage("/roadmap/governance");
  if (!gate.ok || !gate.principal.company) return null;
  const p = gate.principal;
  const company = gate.principal.company;
  const isAdmin = p.companyRole === "admin";

  const [docs, projects] = await Promise.all([
    listGovernanceDocs({ companyId: company.id }),
    listOwnedProjects(p.userId),
  ]);
  const attachedProjectIds = new Set(
    docs.map((d) => d.governanceProjectId).filter(Boolean)
  );

  return (
    <div className="space-y-12">
      <section>
        <span className="sys-label">Step 01 · AI Governance</span>
        <h1 className="mt-4">An AI governance document on file</h1>
        <p className="mt-4 max-w-3xl text-sm">
          Step one of {company.name}&apos;s roadmap: put the document that
          governs how your company uses AI where everyone can find it.{" "}
          {isAdmin
            ? "Upload the one you have, link to it where it lives, attach one you built in the Governance Builder, or create one now."
            : "Attach one you built in the Governance Builder, create one now, or ask a company admin to upload or link the company's document."}
        </p>
      </section>

      <section className="grid gap-6 md:grid-cols-3">
        {isAdmin && (
          <div className="panel">
            <span className="sys-label">Upload · Link</span>
            <h2 className="mt-4 text-lg">Upload or link a document</h2>
            <p className="mt-3 text-sm">
              Already have an AI policy? Put the file itself on record for
              {" "}{company.domain}.
            </p>
            <UploadDocCard />
            <div className="mt-6 border-t border-[var(--xl-line)] pt-4">
              <p className="text-sm">
                Or link to the policy where it already lives. Your team opens
                it there; a sign-in wall is fine.
              </p>
              <LinkDocCard />
            </div>
          </div>
        )}

        <div className="panel">
          <span className="sys-label">Attach</span>
          <h2 className="mt-4 text-lg">Pick from your Governance Builder projects</h2>
          {projects.length === 0 ? (
            <div className="mt-3 space-y-3 text-sm">
              {isAdmin ? (
                <p>
                  You have no Governance Builder projects yet.{" "}
                  <Link href="/governance">Create one in the Governance Builder</Link>{" "}
                  and attach it here.
                </p>
              ) : (
                <p>
                  Built a policy in the Governance Builder? Attach it here, or
                  ask your company admin to upload the company&apos;s
                  document.
                </p>
              )}
            </div>
          ) : (
            <ul className="mt-4 space-y-4">
              {projects.map((proj) => (
                <li
                  key={proj.id}
                  className="border-t border-[var(--xl-line)] pt-3"
                >
                  <div className="text-sm">
                    {KIND_TITLES[proj.kind] ?? "AI Governance Document"}
                  </div>
                  <div className="mono mt-1 text-xs" style={faint}>
                    {proj.domain} · last activity{" "}
                    {fmtDate(proj.lastActivityAt)}
                  </div>
                  <div className="mt-2">
                    <AttachProjectButton
                      projectId={proj.id}
                      attached={attachedProjectIds.has(proj.id)}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-4 text-xs" style={faint}>
            Attaching makes a copy for the company: this copy stays with the
            company workspace and is not deleted after 30 days. Your project
            itself keeps its normal 30-day lifecycle.
          </p>
        </div>

        <div className="panel">
          <span className="sys-label">Create</span>
          <h2 className="mt-4 text-lg">Create one now</h2>
          <p className="mt-3 text-sm">
            No policy yet? The free Governance Builder interviews you one
            question at a time and drafts it with you, shaped to your company.
          </p>
          <Link href="/governance" className="btn btn--text mt-4 no-underline">
            Open the Governance Builder <span aria-hidden="true">→</span>
          </Link>
        </div>
      </section>

      <OnFileList
        docs={docs}
        emptyLine="Nothing on file yet. The step completes the moment the first document or link lands here."
        canRemove={isAdmin}
      />
    </div>
  );
}
