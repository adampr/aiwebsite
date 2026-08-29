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
// Honesty notes: governance is state-honest since the staff governance
// round (owner ruling 2026-08-18): on file / in draft / nothing yet, from
// the staff-lane doc count plus the metadata-only builder draft signal; the
// card never pitches the builder to staff (creation stays with global
// admins, and this card renders for both, so the copy names the admin as
// the actor). The work card's count is DB rows in the internal lane; the
// hand-authored static exhibits on /work are deliberately not counted, so
// this number can read lower than the /work page's card count.

import Link from "next/link";
import {
  ROADMAP_STEPS,
  STAFF_LANE_DOMAIN,
  STAFF_STEP_HREFS,
  isPaidStep,
} from "@/lib/roadmap/config";
import type { StaffRoadmapStatus } from "@/lib/roadmap/status";
import { secureCardLine } from "@/lib/roadmap/platform-copy";
import { RoadmapRunway, RunwayStage } from "@/components/roadmap/runway";
import { DirectoryCard } from "@/components/roadmap/directory-card";
import { WorkEntryCard } from "@/components/roadmap/work-entry-card";

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
    governance: status.governance.done
      ? `${status.governance.docs} on file`
      : status.governance.draft
        ? "In draft"
        : "Nothing on file yet",
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
    // §5.20. "Saved, not counting yet" is a real state and must not read as
    // untouched, and a grace window beats every other line, because a step
    // about to disappear is the one thing the hub must say out loud.
    // Step 09's chain lives in platform-copy.ts, shared with the company
    // hub (src/app/roadmap/page.tsx): this file used to carry a
    // byte-identical copy of it, and both told a saved-but-failing
    // component it had not been added. Do not re-inline it here. Steps 10
    // and 11 keep their inline chains, which have a single component each
    // and so cannot make that mistake.
    secure: secureCardLine(status.secure),
    data: status.data.failing
      ? "A link stopped answering · open this step"
      : status.data.done
      ? "Lakehouse listed"
      : status.data.savedUnverified
        ? "Saved, not counting yet · open this step"
        : "Nothing listed yet",
    tools: status.tools.failing
      ? "A link stopped answering · open this step"
      : status.tools.done
      ? `${status.tools.counted} of ${status.tools.total} ${status.tools.total === 1 ? "tool" : "tools"} counting`
      : status.tools.total > 0
        ? "Saved, not counting yet · open this step"
        : "Nothing listed yet",
  };
  const blurbs: Record<string, string> = {
    governance:
      "The document that governs how XL.net itself uses AI, on file where " +
      "every staff member can read it. An XL.net global admin creates and " +
      "files it.",
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
    governance: status.governance.done
      ? "Read the document"
      : "See where it stands",
    work: "Submit a build",
    request: "Request AI-built work",
    requested: "See the board",
    scorecard: "See who is building",
    secure: "Set up the platform",
    data: "Add the lakehouse",
    tools: "Add a tool",
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

      {/* Nav restructure 2026-08-19: the staff top nav no longer carries a
          /work link at all, so the hub's entry card is staff's nav path to
          the public showcase. */}
      <WorkEntryCard label="XL.net Work" />

      {/* xl:-mx-32: the SAME container breakout the company hub, the teaser
          and the (steps) shell use. Tier 3 of roadmap.css needs 1232px for
          eleven titled stops and .rmp-stop is flex:none, so without this the
          staff runway simply overflows its max-w-5xl box at xl and up. */}
      <section aria-label="Roadmap progress" className="xl:-mx-32">
        <RunwayStage>
          <RoadmapRunway status={status} hrefs={STAFF_STEP_HREFS} />
          {/* Same single stats line as the company hub, inside the stage
              under the runway. */}
          {/* mx-auto is load-bearing: futurism.css gives every bare p a
              max-width of 62ch, so without it the box left-anchors in the
              wide stage and text-center only centers within the box. */}
          <p className="mono mx-auto mt-6 text-center text-xs" style={faint}>
            {status.directory.people} people · {status.work.published} published
            · {status.requested.open} requests open ·{" "}
            {status.scorecard.contributors} builders
          </p>
        </RunwayStage>
      </section>

      <section className="grid gap-6 sm:grid-cols-2">
        {ROADMAP_STEPS.map((step) => {
          const href = STAFF_STEP_HREFS[step.key];
          if (isPaidStep(step)) {
            // Same admin-attested attendance line as the company hub's paid
            // card (set on /admin/roadmap, staff lane): informational only,
            // authenticated surfaces only, availability-neutral copy.
            const attended = status.attendance[step.key];
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
                {attended > 0 && (
                  <p className="mono mt-3 text-xs" style={faint}>
                    {attended} team {attended === 1 ? "member" : "members"}{" "}
                    attended
                  </p>
                )}
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
