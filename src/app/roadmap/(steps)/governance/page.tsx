// Roadmap step 1: AI Governance (§5.18). Admins upload documents or attach
// their own Governance Builder projects; MEMBERS may also attach their OWN
// projects (attach is member-actionable; upload and remove are admin-only).
// The gate is called here as well as in the (steps) layout - a denied
// render returns null and the layout's denial screen is what the visitor
// sees. All data is fetched with the principal's company id, never a
// client-supplied one.

import type { Metadata } from "next";
import Link from "next/link";
import { requireRoadmapPage } from "@/lib/roadmap/access";
import { listGovernanceDocs } from "@/lib/roadmap/db";
import { listOwnedProjects } from "@/lib/governance/db";
import { fmtDate } from "@/components/roadmap/dates";
import {
  AttachProjectButton,
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

export default async function RoadmapGovernancePage() {
  const gate = await requireRoadmapPage("/roadmap/governance");
  if (!gate.ok || !gate.principal.company) return null;
  const p = gate.principal;
  const company = gate.principal.company;
  const isAdmin = p.companyRole === "admin";

  const [docs, projects] = await Promise.all([
    listGovernanceDocs(company.id),
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
          governs how your company uses AI where everyone can find it. Upload
          the one you have, attach one you built in the Governance Builder,
          or create one now.
        </p>
      </section>

      <section className="grid gap-6 md:grid-cols-3">
        {isAdmin && (
          <div className="panel">
            <span className="sys-label">Upload</span>
            <h2 className="mt-4 text-lg">Upload a document</h2>
            <p className="mt-3 text-sm">
              Already have an AI policy? Put the file itself on record for
              {" "}{company.domain}.
            </p>
            <UploadDocCard />
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

      <section>
        <span className="sys-label">On File</span>
        {docs.length === 0 ? (
          <p className="mt-4 text-sm" style={faint}>
            Nothing on file yet. The step completes the moment the first
            document lands here.
          </p>
        ) : (
          <ul className="mt-4 space-y-4">
            {docs.map((doc) => (
              <li key={doc.id} className="panel">
                <div className="flex flex-wrap items-center gap-4">
                  <span className="badge badge--light">
                    {doc.source === "upload" ? "Upload" : "Builder"}
                  </span>
                  <h2 className="text-lg">{doc.title}</h2>
                </div>
                <p className="mono mt-3 text-xs" style={faint}>
                  added by {doc.addedByEmail} · {fmtDate(doc.createdAt)}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-4">
                  <a
                    href={`/api/roadmap/docs/${doc.id}`}
                    className="btn btn--text no-underline"
                  >
                    Download
                  </a>
                  {isAdmin && <RemoveDocButton docId={doc.id} />}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
