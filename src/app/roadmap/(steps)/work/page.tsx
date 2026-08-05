// Roadmap step 04: Submit AI-Built Work (§5.18). Three zones: how work gets
// in (the SHARED /work submission dialog + the email lane, whose DKIM
// prerequisite is the DkimStep island inside the email panel), the viewer's
// own submissions in review (admins also see company submission METADATA,
// never held or failed content), and the company's published cards through
// the SAME card template as /work. Submitting is member-actionable; there
// is no admin gate on building things.
//
// checkDkim rides this page's Promise.all rather than roadmapStatus() (which
// would drag three unrelated queries in). It shares the module's in-memory
// per-process cache with the hub (10 minutes for a real verdict, 60s for a
// dns-error), so a hub visit warms this page and the second probe is usually
// free.

import type { Metadata } from "next";
import { requireRoadmapPage } from "@/lib/roadmap/access";
import {
  companySubmissions,
  mySubmissions,
  publishedCards,
  type CompanySubmissionMeta,
  type PublishedCard,
} from "@/lib/work/db";
import { checkDkim } from "@/lib/roadmap/dkim";
import { CommunityCard } from "@/components/work-card";
import { DkimStep } from "@/components/roadmap/dkim-step";
import { EmailLink } from "@/components/email-link";
import { fmtDate } from "@/components/roadmap/dates";
import { RetrySubmission, RoadmapSubmitEntry } from "./work-islands";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Submit AI-Built Work · Your AI Roadmap",
  robots: { index: false, follow: false },
};

const faint = { color: "var(--xl-text-faint)" } as const;

const STATUS_LABELS: Record<string, string> = {
  received: "Queued for review",
  running: "In review",
  held: "Held for review",
  pending_approval: "Awaiting approval",
  published: "Published",
  failed: "Failed",
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export default async function RoadmapWorkPage() {
  const gate = await requireRoadmapPage("/roadmap/work");
  if (!gate.ok || !gate.principal.company) return null;
  const p = gate.principal;
  const company = gate.principal.company;
  const isAdmin = p.companyRole === "admin";

  const [mine, cards, dkim] = await Promise.all([
    mySubmissions(p.email),
    publishedCards({ companyId: company.id }),
    checkDkim(company.domain, { budgetMs: 800 }),
  ]);
  let companyMeta: CompanySubmissionMeta[] = [];
  if (isAdmin) {
    companyMeta = await companySubmissions(company.id);
  }
  const myIds = new Set(mine.map((r) => r.id));

  return (
    <div className="space-y-14">
      <section>
        <span className="sys-label">Step 04 · Submit AI-Built Work</span>
        <h1 className="mt-4">Ship it, then show it</h1>
        <p className="mt-4 max-w-3xl text-sm">
          Built something with AI? Submit it and an automated editorial panel
          reviews it, drafts a card from your documents, and publishes only
          what it can verify to {company.name}&apos;s private page below.
        </p>
      </section>

      <section>
        <span className="sys-label">How Work Gets In</span>
        <div className="mt-4 grid gap-6 md:grid-cols-2">
          <div className="panel">
            <h2 className="text-lg">Submit it here</h2>
            <p className="mt-3 text-sm">
              Upload the package and the documents behind it; the panel takes
              it from there. You get an email either way.
            </p>
            <div className="mt-4">
              <RoadmapSubmitEntry orgName={company.name} />
            </div>
          </div>
          <div className="panel">
            <h2 className="text-lg">Email it to Tron</h2>
            <p className="mt-3 text-sm">
              Attach your package and mail it to{" "}
              <EmailLink email="Tron.Netter@ai.xl.net" className="mono" />.
              Send it from your {company.domain}{" "}
              address; that is how it reaches your company&apos;s roadmap.
            </p>
            <p className="mt-3 text-xs" style={faint}>
              This lane only: mail from {company.domain}{" "}
              has to be DKIM-signed, which is how we know a submission really
              came from your team. The form beside this one needs none of it.
            </p>
            <DkimStep initial={dkim} email={p.email} />
          </div>
        </div>
        <p className="mt-4 max-w-3xl text-xs" style={faint}>
          Published submissions are credited to your name and counted on your
          company&apos;s scorecard, which everyone at {company.domain} who
          signs in can see.
        </p>
      </section>

      <section>
        <span className="sys-label">In Review</span>
        {mine.length === 0 ? (
          <p className="mt-4 text-sm" style={faint}>
            You have not submitted anything yet.
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {mine.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-[var(--xl-line)] pt-3 text-sm"
              >
                <span>{row.title}</span>
                <span className="badge">{statusLabel(row.status)}</span>
                <span className="mono text-xs" style={faint}>
                  {fmtDate(row.createdAt)}
                </span>
                {/* Queued rows get the manual lever too (the retry route
                    already authorizes company submitters on their own rows;
                    the missing button here made the queued email receipt's
                    Retry pointer false, design-panel finding 2026-08-05). */}
                {(row.status === "failed" || row.status === "received") && (
                  <RetrySubmission id={row.id} />
                )}
              </li>
            ))}
          </ul>
        )}

        {isAdmin && companyMeta.length > 0 && (
          <div className="mt-8">
            <span className="sys-label">All {company.name} Submissions</span>
            <p className="mt-2 text-xs" style={faint}>
              Admin view: titles, status, and dates only. Held and failed
              content stays with its submitter.
            </p>
            <ul className="mt-3 space-y-3">
              {companyMeta.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-[var(--xl-line)] pt-3 text-sm"
                >
                  <span>{row.title}</span>
                  <span className="badge">{statusLabel(row.status)}</span>
                  <span className="mono text-xs" style={faint}>
                    {fmtDate(row.createdAt)}
                    {myIds.has(row.id) ? " · you" : ` · ${row.submitterEmail}`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="space-y-8">
        <div>
          <span className="sys-label">Published by {company.name}</span>
          {cards.length === 0 && (
            <p className="mt-4 text-sm" style={faint}>
              Nothing published yet. The first card that survives the panel
              lands here, and the scorecard goes live with it.
            </p>
          )}
        </div>
        {cards.map((item: PublishedCard, i: number) => (
          <CommunityCard
            key={item.id}
            item={item}
            index={i}
            defaultCredit={`the ${company.name} team`}
          />
        ))}
      </section>
    </div>
  );
}
