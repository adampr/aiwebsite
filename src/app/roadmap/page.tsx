// /roadmap hub (§5.18): dual-render, governance/page.tsx pattern. Signed-out
// visitors get the crawlable teaser (never a redirect); signed-in users get
// their state via readRoadmapHubView (round 2): the staff explainer, the
// one-shot silent Google re-verify bounce, the "One last check" verification
// screen, the ineligible-domain explainer, the bootstrap card, or the
// company status board. NO company data ever renders signed-out or to an
// untrusted session. Metadata is session-aware: the teaser is the indexable
// marketing surface, every signed-in render is noindex.

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { readSession } from "@aicompany/core/auth/session";
import { siteConfig } from "site.config";
import { readRoadmapHubView } from "@/lib/roadmap/access";
import {
  ROADMAP_STEPS,
  isPaidStep,
  roadmapEnabled,
} from "@/lib/roadmap/config";
import { roadmapStatus } from "@/lib/roadmap/status";
import {
  deniedAdminRequestInWindow,
  openAdminRequest,
} from "@/lib/roadmap/db";
import { RoadmapRunway } from "@/components/roadmap/runway";
import { RequestAdminAccess } from "@/components/roadmap/request-admin";
import { BootstrapCard } from "@/components/roadmap/bootstrap-card";
import { ConfirmIdentity } from "@/components/roadmap/confirm-identity";
import { DirectoryCard } from "@/components/roadmap/directory-card";
import { StaffPanel } from "@/components/roadmap/staff-panel";
import "./roadmap.css";

export const dynamic = "force-dynamic";

const faint = { color: "var(--xl-text-faint)" } as const;

export async function generateMetadata(): Promise<Metadata> {
  const session = await readSession(siteConfig);
  if (session) {
    return {
      title: "Your AI Roadmap",
      robots: { index: false, follow: false },
    };
  }
  return {
    title: "Your AI Roadmap: From Knowledge Workers to AI Builders",
    description:
      "A private six-step roadmap for your company: governance on file, your team listed, AI-built work reviewed and published, builders on a scorecard, plus a paid workshop and monthly cohort.",
    alternates: { canonical: "/roadmap" },
  };
}

const FAQ = [
  {
    q: "Is it free?",
    a: "The roadmap itself is free: sign in with your work email, no card, no trial clock. Two of the six steps are paid training, booked separately on our AI Builders page: the AI Builders Workshop ($995 for one four-hour session) and the AI Builder Cohort ($495 per month). Every other step works without buying either.",
  },
  {
    q: "Who can see our data?",
    a: "Only signed-in people on your company's email domain, and XL.net administrators, who operate and support the service. Company roadmaps never appear in search engines or to other companies.",
  },
  {
    q: "Why a work email?",
    a: "Your email domain is what groups your company's workspace: everyone at your domain sees the same roadmap. Personal addresses like gmail.com cannot anchor a company workspace.",
  },
  {
    q: "What is a company admin?",
    a: "The person who manages your workspace: governance documents, the directory, and approving admin access for colleagues. The first person to set up the workspace becomes its admin.",
  },
  {
    q: "How does work get submitted?",
    a: "Upload a build through the submission form, or email it to Tron from your work address. Emailed submissions count only once your domain signs its mail (DKIM), and the submit step shows you how to check and set that up. An automated editorial panel reviews every submission and publishes only what it can verify.",
  },
] as const;

function Teaser() {
  return (
    <div className="mx-auto max-w-5xl space-y-16">
      <section className="pt-8 text-center">
        <span className="sys-label sys-label--center">
          Home / Your AI Roadmap
        </span>
        <h1 className="mt-8">
          From knowledge workers to <span className="glow">AI builders</span>
        </h1>
        <p className="mx-auto mt-6 max-w-3xl text-lg">
          A private roadmap for your whole company: six steps from an AI
          governance document on file to a scorecard of the builders on your
          team, with every piece of AI-built work reviewed and published
          along the way, and training to grow the builders themselves.
        </p>
        <div className="mt-10 flex flex-wrap justify-center gap-6">
          <Link
            href="/login?redirect=/roadmap"
            className="btn btn--primary no-underline"
          >
            Sign in with your work email
          </Link>
        </div>
        <p className="mono mx-auto mt-6 max-w-2xl text-xs" style={faint}>
          six steps · four free, two paid training · private to your company
        </p>
      </section>

      <hr className="horizon" />

      <section>
        <div className="text-center">
          <span className="sys-label sys-label--center">The Runway</span>
          <h2 className="mt-6">Six stations, one line</h2>
        </div>
        {/* max-w-5xl, not 4xl: the six-stop horizontal runway needs 928px
            and the 4xl wrap (896px) cannot hold it (roadmap.css lg math). */}
        <div className="mx-auto mt-12 max-w-5xl">
          <RoadmapRunway status={null} />
        </div>
        <div className="mt-12 grid gap-6 sm:grid-cols-2">
          {ROADMAP_STEPS.map((step) => (
            <div key={step.key} className="panel rise">
              <div className="flex items-baseline justify-between gap-4">
                <span className="sys-label">{step.num}</span>
                {isPaidStep(step) && (
                  <span className="mono text-xs" style={faint}>
                    {step.fee} · booked separately
                  </span>
                )}
              </div>
              <h3 className="mt-4">{step.title}</h3>
              <p className="mt-4 text-sm">{step.blurb}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-3xl">
        <div className="panel panel--lightline">
          <span className="sys-label">Private by Design</span>
          <p className="mt-4 text-sm">
            Your roadmap is private to your company. Only signed-in people on
            your email domain, and XL.net, can see it. The first person from
            your company to set up the workspace becomes its admin. Others can
            request admin access, which any current admin or XL.net can
            approve.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-3xl">
        <div className="text-center">
          <span className="sys-label sys-label--center">Straight Answers</span>
          <h2 className="mt-6">Answered before you ask</h2>
        </div>
        <div className="mt-10 space-y-8">
          {FAQ.map((item) => (
            <div key={item.q}>
              <h3 className="text-lg">{item.q}</h3>
              <p className="mt-2 max-w-none text-sm">{item.a}</p>
            </div>
          ))}
        </div>
        <div className="mt-12 text-center">
          <Link
            href="/login?redirect=/roadmap"
            className="btn btn--text no-underline"
          >
            Sign in and see your roadmap <span aria-hidden="true">→</span>
          </Link>
        </div>
      </section>
    </div>
  );
}

type Search = { searchParams: Promise<{ verify?: string }> };

export default async function RoadmapHubPage({ searchParams }: Search) {
  const view = await readRoadmapHubView();

  if (view.kind === "anonymous") return <Teaser />;

  if (view.kind === "staff") {
    return (
      <StaffPanel email={view.email} showAdminLink={view.showAdminLink} />
    );
  }

  if (view.kind === "unverified") {
    // One-shot silent Google re-verify: a server-side bounce BEFORE any HTML
    // renders. The reverify route sets its own guard cookie, so a failed
    // round trip returns with attempted=true (and possibly
    // ?verify=google_unverified) and lands on the screen below, never a
    // loop.
    if (view.silentEligible && !view.attempted) {
      redirect("/api/auth/reverify?redirect=/roadmap");
    }
    const { verify } = await searchParams;
    // Untrusted provider: no company data, not even the name.
    return (
      <ConfirmIdentity
        email={view.email}
        reservedDomain={view.reservedDomain}
        attempted={view.attempted}
        verifyFlag={verify === "google_unverified"}
      />
    );
  }

  const p = view.principal;

  if (!p.domainEligible) {
    return (
      <div className="mx-auto max-w-xl space-y-6 pt-8 text-center">
        <span className="sys-label sys-label--center">Your AI Roadmap</span>
        <h1>A workspace needs a work email</h1>
        <p className="text-sm">
          The roadmap is built around a company email domain: everyone who
          signs in at your domain shares one workspace. You are signed in as{" "}
          <span className="mono">{p.email}</span>, which cannot anchor one.
          Sign in with your work email to get started.
        </p>
        <div>
          <Link
            href="/login?redirect=/roadmap"
            className="btn no-underline"
          >
            Sign in with your work email
          </Link>
        </div>
      </div>
    );
  }

  const apolloEnabled =
    !!process.env.APOLLO_API_KEY && roadmapEnabled(process.env);

  if (!p.company) {
    return (
      <div className="space-y-10 pt-8">
        <div className="text-center">
          <span className="sys-label sys-label--center">Your AI Roadmap</span>
          <h1 className="mt-6">
            No workspace for <span className="glow">{p.emailDomain}</span> yet
          </h1>
        </div>
        <BootstrapCard domain={p.emailDomain} apolloEnabled={apolloEnabled} />
      </div>
    );
  }

  // Member or admin of a company: the action center.
  const company = p.company;
  const status = await roadmapStatus(company.id, company.domain);
  const isAdmin = p.companyRole === "admin";
  // Directory auto-init (round 3): kick an Apollo import from the hub for an
  // admin whose company has never had a COMPLETE run. Server-side predicate
  // only; the client adds the sessionStorage fence.
  const autoInit =
    isAdmin &&
    status.directory.people === 0 &&
    !status.directory.everImported &&
    company.status === "active" &&
    apolloEnabled;
  // Round 5 (owner ask): the hub card's manual "Recheck database" lever.
  // Render predicate only; the admin-gated import route re-checks all of it.
  const canRecheck = isAdmin && company.status === "active" && apolloEnabled;
  let pending: { requestedAt: string; expiresAt: string } | null = null;
  if (!isAdmin) {
    const open = await openAdminRequest(p.company.id, p.userId);
    // A denied request renders exactly like a pending one until its expiry
    // (denial is observably identical to non-approval by ruling).
    const standing =
      open ?? (await deniedAdminRequestInWindow(p.company.id, p.userId));
    if (standing) {
      pending = {
        requestedAt: standing.createdAt.toISOString(),
        expiresAt: standing.expiresAt.toISOString(),
      };
    }
  }

  // Count lines live on the cards; the directory card computes its own
  // (DirectoryCard owns every step-02 state).
  const stepLines = {
    governance: status.governance.done
      ? `${status.governance.docs} on file`
      : "Nothing on file yet",
    work: status.work.done
      ? `${status.work.published} published`
      : "Nothing published yet",
    scorecard: status.scorecard.live
      ? `${status.scorecard.contributors} ${status.scorecard.contributors === 1 ? "builder" : "builders"} so far`
      : "Waiting on the first published work",
  } as const;
  // The email lane's DKIM state, echoed on the work card (its controls live
  // one click away on /roadmap/work). It renders for EVERY verdict, never
  // just the informative two: "other-provider" is the fall-through for any
  // domain that is not Microsoft 365 or Google Workspace, so gating it would
  // leave those tenants with no DKIM signal anywhere on the hub. Wording is
  // record-scoped by standing ruling (DNS proves publication, never that the
  // provider's signing switch is on, and never that a gateway is not already
  // signing under its own selector), and the two states that need an action
  // name where that action lives. "not live yet" rather than "records not
  // found": two of the four missing reasons (key-revoked, m365-cname-dead)
  // are record-PRESENT states, and the dialog one click away says so in
  // words ("the two DKIM records ... are installed", "a DKIM record exists").
  const dkimLine =
    status.dkim.timedOut === true
      ? "Email lane · checking DKIM now · open this step"
      : status.dkim.verdict === "ok"
        ? "Email lane · DKIM records live"
        : status.dkim.verdict === "missing"
          ? "Email lane · DKIM not live yet · open this step"
          : "Email lane · DKIM needs a manual check · open this step";
  // CTA labels come from the SAME status booleans as stepLines so the two
  // can never disagree.
  const stepDone = {
    governance: status.governance.done,
    work: status.work.done,
    scorecard: status.scorecard.live,
  } as const;

  return (
    <div className="mx-auto max-w-5xl space-y-14">
      <section className="pt-8">
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <div>
            <span className="sys-label">Your AI Roadmap</span>
            <h1 className="mt-4">{p.company.name}</h1>
          </div>
          <span className="mono text-xs" style={faint}>
            {p.email}
            {isAdmin ? " · admin" : ""}
          </span>
        </div>
      </section>

      <section aria-label="Roadmap progress">
        <RoadmapRunway status={status} />
      </section>

      {/* One faint mono line replaced the 4-stat monument section: a
          deliberate panel ruling (round 3) - the cards now carry the counts,
          so a second numeric surface was noise. */}
      <section>
        <p className="mono text-center text-xs" style={faint}>
          {status.governance.docs} docs · {status.directory.people} people ·{" "}
          {status.work.published} published ·{" "}
          {status.scorecard.contributors} builders
        </p>
      </section>

      {/* Action-center cards (round 3): stretched-overlay pattern. Each card
          has ONE interactive element, the bottom CTA, whose ::after
          stretches over the whole card (one tab stop, accessible name = the
          verb). Round-5 exception: the directory card adds an admin-only
          "Recheck database" button raised above the overlay
          (.rmp-card-action). Card text is not mouse-selectable under the
          overlay: accepted trade-off. The runway above is the single state
          surface; cards carry counts and verbs, never state badges.
          Branch order is load-bearing: directory, then work, then the paid
          branch, and only then the generic return, whose stepLines/stepDone
          lookups are exhaustive ONLY once the other keys have returned. */}
      <section className="grid gap-6 sm:grid-cols-2">
        {ROADMAP_STEPS.map((step) => {
          if (step.key === "directory") {
            return (
              <DirectoryCard
                key={step.key}
                autoInit={autoInit}
                canRecheck={canRecheck}
                isAdmin={isAdmin}
                people={status.directory.people}
                everImported={status.directory.everImported}
                domain={company.domain}
                href={step.href}
                num={step.num}
                title={step.title}
                blurb={step.blurb}
                ctaTodo={step.cta.todo}
                ctaDone={step.cta.done}
              />
            );
          }
          if (step.key === "work") {
            // The email lane's DKIM verdict rides THIS card now (the step
            // that owns the lane), as one non-interactive line: the card
            // keeps its single stretched-overlay CTA, and the controls
            // (dialog, Recheck, email-me) live on /roadmap/work where the
            // island can resolve a pending check. id="step-dkim" is the
            // retired step-05 anchor, kept as a landing for old bookmarks;
            // no sent email ever carried it, so it is a courtesy, not a
            // contract. scroll-mt clears the sticky header.
            return (
              <div
                key={step.key}
                id="step-dkim"
                className="panel rise rmp-card scroll-mt-24"
              >
                <div className="flex items-baseline justify-between gap-4">
                  <span className="sys-label">{step.num}</span>
                  <span className="mono text-xs" style={faint}>
                    {stepLines.work}
                  </span>
                </div>
                <h3 className="mt-4">{step.title}</h3>
                <p className="mt-4 text-sm">{step.blurb}</p>
                <p className="mono mt-3 text-xs" style={faint}>
                  {dkimLine}
                </p>
                <Link href={step.href} className="rmp-card-cta">
                  {stepDone.work ? step.cta.done : step.cta.todo}{" "}
                  <span className="rmp-arrow" aria-hidden="true">
                    →
                  </span>
                </Link>
              </div>
            );
          }
          if (isPaidStep(step)) {
            // Bought on /builders, and this server cannot see a purchase, so
            // the card states the price and says so plainly instead of
            // pretending to know whether it is done.
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
                <Link href={step.href} className="rmp-card-cta">
                  {step.cta.todo}{" "}
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
                  {stepLines[step.key]}
                </span>
              </div>
              <h3 className="mt-4">{step.title}</h3>
              <p className="mt-4 text-sm">{step.blurb}</p>
              <Link href={step.href} className="rmp-card-cta">
                {stepDone[step.key] ? step.cta.done : step.cta.todo}{" "}
                <span className="rmp-arrow" aria-hidden="true">
                  →
                </span>
              </Link>
            </div>
          );
        })}
      </section>

      {!isAdmin && (
        <section className="mx-auto max-w-xl">
          <div className="panel">
            <span className="sys-label">Admin Access</span>
            <p className="mt-4 text-sm">
              Uploading documents and managing the directory are admin
              actions. Need them?
            </p>
            <div className="mt-4">
              <RequestAdminAccess pending={pending} />
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
