// Staff hub for /roadmap (§5.18 unification, owner ruling 2026-08-08): xl.net
// staff get the SAME roadmap hub as client companies, backed by the internal
// (public /work) lane. Replaces the old staff-panel.tsx explainer.
//
// SECURITY: rendered off isStaffSession (google + exact-label xl.net; mv not
// required - see the rewritten invariant in src/lib/roadmap/access.ts).
// Everything shown here is bounded above by what weaker staff gates already
// expose: internal-lane published work is public on /work, and the request
// aggregates are visible to any xl.net Google session on /work/requested.
// No client-tenant data renders here, and every CTA lands on a page with its
// own gate.
//
// Honesty notes: governance and directory cannot derive a state without a
// company row (xl.net is RESERVED and can never be one), so those cards
// state what is true and never claim done - the paid-card pattern. The
// runway renders as ornament (no state, no false up-next ring); ACCEPTED
// TRADE-OFF: its hollow diamonds sit beside cards with real counts, chosen
// over wiring a partial status that would have to lie about steps 01-02.
// The work card's count is DB rows in the internal lane; the hand-authored
// static exhibits on /work are deliberately not counted, so this number can
// read lower than the /work page's card count.

import Link from "next/link";
import {
  ROADMAP_STEPS,
  STAFF_STEP_HREFS,
  isPaidStep,
} from "@/lib/roadmap/config";
import type { StaffRoadmapStatus } from "@/lib/roadmap/status";
import { RoadmapRunway } from "@/components/roadmap/runway";

const faint = { color: "var(--xl-text-faint)" } as const;

export function StaffHub({
  email,
  showAdminLink,
  status,
}: {
  email: string;
  showAdminLink: boolean;
  status: StaffRoadmapStatus;
}) {
  const lines: Record<string, string> = {
    governance: "Public offering",
    directory: "Derived from published work",
    work:
      status.work.published > 0
        ? `${status.work.published} published`
        : "Nothing published yet",
    request:
      status.requests.listed > 0
        ? `${status.requests.listed} approved so far`
        : "Nothing approved yet",
    requested:
      status.requests.listed > 0
        ? `${status.requests.open} open · ${status.requests.completed} completed`
        : "Waiting on the first approved request",
    scorecard:
      status.scorecard.contributors > 0
        ? `${status.scorecard.contributors} ${status.scorecard.contributors === 1 ? "builder" : "builders"} so far`
        : "Waiting on the first published work",
  };
  const blurbs: Record<string, string> = {
    governance:
      "Client companies file a governance document here. XL.net's own " +
      "offering is the public Governance Builder.",
    directory:
      "Client companies list their teams here. XL.net's builder list comes " +
      "straight from published work on the scorecard.",
    work:
      "Ship something built with AI and submit it on the site or by email. " +
      "An editorial panel reviews it and publishes it to the public Our " +
      "Work page.",
    scorecard:
      "Watch builders emerge: published public work and requested-work " +
      "activity counted per person. Published cards and approved requests " +
      "only, never drafts or attempts.",
  };
  const ctas: Record<string, string> = {
    governance: "Open the Governance Builder",
    directory: "See the builder list",
    work: "Submit a build",
    request: "Request AI-built work",
    requested: "See the board",
    scorecard: "See who is building",
  };

  return (
    <div className="mx-auto max-w-5xl space-y-14">
      <section className="pt-8">
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <div>
            <span className="sys-label">Your AI Roadmap</span>
            <h1 className="mt-4">XL.net</h1>
          </div>
          <span className="mono text-xs" style={faint}>
            {email} · staff
            {showAdminLink ? " · admin" : ""}
          </span>
        </div>
      </section>

      <section aria-label="Roadmap steps overview">
        <RoadmapRunway
          status={null}
          noInvite
          srSummary="Eight steps. The XL.net lane tracks published work, requested projects, and builders on the cards below."
        />
      </section>

      <section>
        <p className="mono text-center text-xs" style={faint}>
          {status.work.published} published · {status.requests.open} requests
          open · {status.scorecard.contributors} builders
        </p>
      </section>

      <section className="grid gap-6 sm:grid-cols-2">
        {ROADMAP_STEPS.map((step) => {
          const href = STAFF_STEP_HREFS[step.key];
          if (isPaidStep(step)) {
            return (
              <div key={step.key} className="panel rise rmp-card">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="sys-label">{step.num}</span>
                  <span className="mono text-xs" style={faint}>
                    {step.fee} · booked separately
                  </span>
                </div>
                <h3 className="mt-4">{step.title}</h3>
                <p className="mt-4 text-sm">{step.blurb}</p>
                <Link href={href} className="rmp-card-cta">
                  {step.cta.todo}{" "}
                  <span className="rmp-arrow" aria-hidden="true">
                    →
                  </span>
                </Link>
              </div>
            );
          }
          if (step.key === "work") {
            // Two destinations by owner decision: submit (primary CTA with
            // the stretched overlay) and the public page (raised
            // .rmp-card-action link above the overlay - the round-5
            // directory-card exception pattern).
            return (
              <div key={step.key} className="panel rise rmp-card">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="sys-label">{step.num}</span>
                  <span className="mono text-xs" style={faint}>
                    {lines.work}
                  </span>
                </div>
                <h3 className="mt-4">{step.title}</h3>
                <p className="mt-4 text-sm">{blurbs.work}</p>
                <p className="mt-3">
                  <Link href="/work" className="rmp-card-action btn btn--text no-underline">
                    See the public Work page
                  </Link>
                </p>
                <Link href={href} className="rmp-card-cta">
                  {ctas.work}{" "}
                  <span className="rmp-arrow" aria-hidden="true">
                    →
                  </span>
                </Link>
              </div>
            );
          }
          return (
            <div key={step.key} className="panel rise rmp-card">
              <div className="flex items-baseline justify-between gap-4">
                <span className="sys-label">{step.num}</span>
                <span className="mono text-xs" style={faint}>
                  {lines[step.key]}
                </span>
              </div>
              <h3 className="mt-4">{step.title}</h3>
              <p className="mt-4 text-sm">{blurbs[step.key] ?? step.blurb}</p>
              <Link href={href} className="rmp-card-cta">
                {ctas[step.key]}{" "}
                <span className="rmp-arrow" aria-hidden="true">
                  →
                </span>
              </Link>
            </div>
          );
        })}
      </section>

      {showAdminLink && (
        <section className="mx-auto max-w-xl">
          <div className="panel">
            <span className="sys-label">Operations</span>
            <p className="mt-4 text-sm">
              Client workspaces are managed from the admin console.
            </p>
            <Link
              href="/admin/roadmap"
              className="btn btn--text mt-4 no-underline"
            >
              Manage client workspaces <span aria-hidden="true">→</span>
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}
