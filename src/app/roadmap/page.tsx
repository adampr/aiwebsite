// /roadmap hub (§5.18): dual-render, governance/page.tsx pattern. Signed-out
// visitors get the crawlable teaser (never a redirect); signed-in users get
// their state: the untrusted-provider screen, the ineligible-domain
// explainer, the bootstrap card, or the company status board. NO company
// data ever renders signed-out or to an untrusted session. Metadata is
// session-aware: the teaser is the indexable marketing surface, every
// signed-in render is noindex.

import type { Metadata } from "next";
import Link from "next/link";
import { readSession } from "@aicompany/core/auth/session";
import { siteConfig } from "site.config";
import { readRoadmapPrincipal } from "@/lib/roadmap/access";
import { ROADMAP_STEPS } from "@/lib/roadmap/config";
import { roadmapStatus } from "@/lib/roadmap/status";
import {
  deniedAdminRequestInWindow,
  openAdminRequest,
} from "@/lib/roadmap/db";
import { RoadmapRunway } from "@/components/roadmap/runway";
import { RequestAdminAccess } from "@/components/roadmap/request-admin";
import { BootstrapCard } from "@/components/roadmap/bootstrap-card";
import { ConfirmIdentity } from "@/components/roadmap/confirm-identity";
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
      "A private four-step roadmap for your company: put an AI governance document on file, list your team, submit AI-built work for editorial review, and watch builders emerge on your scorecard.",
    alternates: { canonical: "/roadmap" },
  };
}

const FAQ = [
  {
    q: "Is it free?",
    a: "Yes. Sign in with your work email and walk the four steps at no cost. No card, no trial clock.",
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
    a: "Upload a build through the submission form, or email it to Tron from your work address. An automated editorial panel reviews every submission and publishes only what it can verify.",
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
          A private roadmap for your whole company: four steps from an AI
          governance document on file to a scorecard of the builders on your
          team, with every piece of AI-built work reviewed and published along
          the way.
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
          free · private to your company · four steps
        </p>
      </section>

      <hr className="horizon" />

      <section>
        <div className="text-center">
          <span className="sys-label sys-label--center">The Runway</span>
          <h2 className="mt-6">Four stations, one line</h2>
        </div>
        <div className="mx-auto mt-12 max-w-4xl">
          <RoadmapRunway status={null} />
        </div>
        <div className="mt-12 grid gap-6 sm:grid-cols-2">
          {ROADMAP_STEPS.map((step) => (
            <div key={step.key} className="panel rise">
              <span className="sys-label">{step.num}</span>
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

export default async function RoadmapHubPage() {
  const result = await readRoadmapPrincipal();

  if (!result.ok) {
    if (result.reason === "unauthenticated") return <Teaser />;
    // Untrusted provider: no company data, not even the name.
    return <ConfirmIdentity email={result.email} redirect="/roadmap" />;
  }

  const p = result.principal;

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

  if (!p.company) {
    return (
      <div className="space-y-10 pt-8">
        <div className="text-center">
          <span className="sys-label sys-label--center">Your AI Roadmap</span>
          <h1 className="mt-6">
            No workspace for <span className="glow">{p.emailDomain}</span> yet
          </h1>
        </div>
        <BootstrapCard domain={p.emailDomain} />
      </div>
    );
  }

  // Member or admin of a company: the status board.
  const status = await roadmapStatus(p.company.id);
  const isAdmin = p.companyRole === "admin";
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

  const counts = [
    { value: status.governance.docs, label: "Governance docs" },
    { value: status.directory.people, label: "People listed" },
    { value: status.work.published, label: "Works published" },
    { value: status.scorecard.contributors, label: "Builders" },
  ];
  const stepLines = {
    governance: status.governance.done
      ? `${status.governance.docs} on file`
      : "Nothing on file yet",
    directory: status.directory.done
      ? `${status.directory.people} ${status.directory.people === 1 ? "person" : "people"} listed`
      : "No one listed yet",
    work: status.work.done
      ? `${status.work.published} published`
      : "Nothing published yet",
    scorecard: status.scorecard.live
      ? `${status.scorecard.contributors} ${status.scorecard.contributors === 1 ? "builder" : "builders"} so far`
      : "Waiting on the first published work",
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

      <section className="grid gap-10 text-center sm:grid-cols-4">
        {counts.map((c) => (
          <div key={c.label} className="stat">
            <div className="stat-value">{c.value}</div>
            <div className="stat-label">{c.label}</div>
          </div>
        ))}
      </section>

      <section className="grid gap-6 sm:grid-cols-2">
        {ROADMAP_STEPS.map((step) => (
          <div key={step.key} className="panel rise">
            <div className="flex items-baseline justify-between gap-4">
              <span className="sys-label">{step.num}</span>
              <span className="mono text-xs" style={faint}>
                {stepLines[step.key]}
              </span>
            </div>
            <h3 className="mt-4">{step.title}</h3>
            <p className="mt-4 text-sm">{step.blurb}</p>
            <Link
              href={step.href}
              className="btn btn--text mt-5 no-underline"
            >
              Open step {step.num} <span aria-hidden="true">→</span>
            </Link>
          </div>
        ))}
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
