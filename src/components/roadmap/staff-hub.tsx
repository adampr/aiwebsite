// Staff hub for /roadmap (§5.18 unification, owner ruling 2026-08-08; staff
// PARITY round 2026-08-09): xl.net staff get the SAME roadmap hub as client
// companies, backed by the internal (public /work) lane plus the NULL-lane
// staff directory. Replaces the old staff-panel.tsx explainer; the round-1
// ornament runway ("accepted trade-off") is retired - the runway now shows
// REAL staff state, with stops linking STAFF_STEP_HREFS.
//
// SECURITY: rendered off isStaffSession (a verified staff provider +
// exact-label xl.net; Google needs no mv, Microsoft requires the per-login
// mv claim - see the rewritten invariant in src/lib/roadmap/access.ts).
// Everything shown here is bounded above by what weaker staff gates already
// expose (internal-lane published work is public on /work, request
// aggregates are visible to any verified xl.net staff session on
// /work/requested, and the staff directory is XL's own staff shown to XL's
// own staff). No client-tenant data renders here, every CTA lands on a page
// with its own gate, and globalAdmin gates RENDER decisions only; every
// write re-derives requireGlobalAdmin server-side.
//
// Honesty notes: governance renders constant-done (XL.net's governance IS
// its public offering: the Governance Builder plus the published AUP; the
// card says so rather than pretending a document is on file). The work
// card's count is DB rows in the internal lane; the hand-authored static
// exhibits on /work are deliberately not counted, so this number can read
// lower than the /work page's card count.

import Link from "next/link";
import {
  ROADMAP_STEPS,
  STAFF_LANE_DOMAIN,
  STAFF_STEP_HREFS,
  isPaidStep,
} from "@/lib/roadmap/config";
import type { StaffRoadmapStatus } from "@/lib/roadmap/status";
import { RoadmapRunway, RunwayStage } from "@/components/roadmap/runway";
import { DirectoryCard } from "@/components/roadmap/directory-card";

const faint = { color: "var(--xl-text-faint)" } as const;

export function StaffHub({
  email,
  globalAdmin,
  autoInit,
  canRecheck,
  status,
}: {
  email: string;
  globalAdmin: boolean;
  autoInit: boolean;
  canRecheck: boolean;
  status: StaffRoadmapStatus;
}) {
  const lines: Record<string, string> = {
    governance: "Public offering",
    work: status.work.done
      ? `${status.work.published} published`
      : "Nothing published yet",
    request: status.request.done
      ? `${status.request.listed} approved so far`
      : "Nothing approved yet",
    requested: status.requested.live
      ? `${status.requested.open} open · ${status.requested.completed} completed`
      : "Waiting on the first approved request",
    scorecard: status.scorecard.live
      ? `${status.scorecard.contributors} ${status.scorecard.contributors === 1 ? "builder" : "builders"} so far`
      : "Waiting on the first published work",
  };
  const blurbs: Record<string, string> = {
    governance:
      "Client companies file a governance document here. XL.net's own " +
      "offering is the public Governance Builder.",
    work:
      "Ship something built with AI and submit it on the site or by email. " +
      "An editorial panel reviews it and publishes it to the public Our " +
      "Work page.",
    scorecard:
      "Watch builders emerge: published public work and requested-work " +
      "activity counted per person in the directory. Published cards and " +
      "approved requests only, never drafts or attempts.",
  };
  const ctas: Record<string, string> = {
    governance: "Open the Governance Builder",
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
            {globalAdmin ? " · admin" : ""}
          </span>
        </div>
      </section>

      <section aria-label="Roadmap progress">
        <RunwayStage>
          <RoadmapRunway status={status} hrefs={STAFF_STEP_HREFS} />
          {/* Same hub orientation caption as the company hub (hoisted out
              of runway.tsx in the staff-parity round). */}
          <p className="mono mt-6 text-center text-xs" style={faint}>
            Start wherever helps most. Two steps are paid training, booked on
            the Builders page.
          </p>
        </RunwayStage>
      </section>

      <section>
        <p className="mono text-center text-xs" style={faint}>
          {status.directory.people} people · {status.work.published} published
          · {status.requested.open} requests open ·{" "}
          {status.scorecard.contributors} builders
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
          if (step.key === "directory") {
            // Real staff directory (NULL lane): the same auto-init/recheck
            // card the company hub uses, fenced by
            // apolloKickGuardKey(STAFF_LANE_DOMAIN) - the ONE constant, so
            // hub -> step navigation cannot double-kick.
            return (
              <DirectoryCard
                key={step.key}
                autoInit={autoInit}
                canRecheck={canRecheck}
                isAdmin={globalAdmin}
                people={status.directory.people}
                everImported={status.directory.everImported}
                domain={STAFF_LANE_DOMAIN}
                href={href}
                num={step.num}
                title={step.title}
                blurb={
                  "List the people on this journey. Import the XL.net team " +
                  "from Apollo or add them by hand; an XL.net admin keeps " +
                  "it current."
                }
                ctaTodo={step.cta.todo}
                ctaDone={step.cta.done}
                memberInitLine="An XL.net admin can initialize this from Apollo."
              />
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

      {globalAdmin && (
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
