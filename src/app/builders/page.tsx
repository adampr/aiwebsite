import type { Metadata } from "next";
import Link from "next/link";
import { CheckoutButton } from "@/components/checkout-button";

export const metadata: Metadata = {
  title: "AI Builders",
  description:
    "Become an AI Builder — learn to build your own AI workflows and automations the smart and safe way, taught by the XL.net team. Weekly cohort or four-hour workshop.",
  alternates: { canonical: "/builders" },
  openGraph: {
    title: "AI Builders — XL.net AI",
    description:
      "Become an AI Builder — learn to build your own AI workflows and automations the smart and safe way, taught by the XL.net team.",
  },
};

// The workshop card flips to a "next date TBA" state once the July 30
// session has started (8:00am CT = 13:00 UTC), so the page never advertises
// a past event. Requires dynamic rendering — do not remove force-dynamic.
export const dynamic = "force-dynamic";
const WORKSHOP_STARTS = Date.parse("2026-07-30T13:00:00Z");

// Self-hosted copy of the May 21 Zoom webinar recording (54 min, 136 MB).
// The file is gitignored; it lives in public/media/ on the dev box and ships
// to the VM via deploy.sh's repo rsync (like data/GeoLite2, but in-tree).
const WEBINAR_URL = "/media/ai-in-the-workplace-webinar-2026-05.mp4";
const RECAP_URL = "https://youtube.com/shorts/XFpJpTT4_MI";

export default function BuildersPage() {
  const workshopOpen = Date.now() < WORKSHOP_STARTS;

  return (
    <div className="mx-auto max-w-5xl space-y-16">
      {/* Hero — the thesis as identity */}
      <section className="pt-8 text-center">
        <span className="sys-label sys-label--center">Home / AI Builders</span>
        <h1 className="mt-8">
          Become an <span className="glow">AI Builder</span>
        </h1>
        <p className="mx-auto mt-6 max-w-3xl text-lg">
          An AI Builder is anyone who uses AI to build their own workflows and
          automations. We believe most knowledge workers will be AI Builders
          by 2028 — and we started with ourselves.{" "}
          <Link href="/work">See what we&apos;ve built</Link>, then learn to
          build your own — the smart and safe way.
        </p>
      </section>

      <hr className="horizon" />

      {/* Pricing — two different jobs, not two tiers */}
      <section>
        <div className="mb-12 text-center">
          <span className="sys-label sys-label--center">Two Ways In</span>
          <h2 className="shimmer mt-6">Pick the format that fits</h2>
        </div>
        {/* Subgrid keeps the two cards' rows in lockstep (badge, title, price,
            list, CTA, fine print) so the checkout buttons align horizontally. */}
        <div className="grid gap-6 sm:grid-cols-2 sm:grid-rows-[auto_auto_auto_auto_1fr_auto_auto]">
          {/* Workshop — primary */}
          <div className="panel panel--lightline rise sm:row-span-7 sm:grid sm:grid-rows-subgrid">
            <span className="badge badge--light">
              <span className="dot" />{" "}
              {workshopOpen ? "Next session: July 30" : "Next date: TBA"}
            </span>
            <h3 className="mt-6">Virtual Workshop</h3>
            <p className="mt-2 text-sm" style={{ color: "var(--xl-text-faint)" }}>
              Build real workflows in one morning.
            </p>
            <div className="stat mt-6">
              <div className="stat-value">
                $995<em> one-time</em>
              </div>
            </div>
            <ul className="mt-6 space-y-2 text-sm">
              <li>Four hours online, hands-on — not a lecture</li>
              <li>Build real AI workflows and automations you keep</li>
              {workshopOpen ? (
                <li>
                  Thursday, July 30 · 8:00am–12:00pm CT
                </li>
              ) : (
                <li>Next session being scheduled now</li>
              )}
              <li>
                Date doesn&apos;t work after you buy?{" "}
                <Link href="/contact">Contact us</Link>{" "}
                and we&apos;ll move you to the next session.
              </li>
            </ul>
            <div className="mt-8">
              {workshopOpen ? (
                <CheckoutButton offering="workshop">
                  Reserve your seat — $995 one-time
                </CheckoutButton>
              ) : (
                <Link href="/contact" className="btn no-underline">
                  Get notified about the next date
                </Link>
              )}
            </div>
            <p className="mt-4 text-xs" style={{ color: "var(--xl-text-faint)" }}>
              Secure card payment on Stripe-hosted checkout.
            </p>
          </div>

          {/* Cohort */}
          <div
            className="panel rise sm:row-span-7 sm:grid sm:grid-rows-subgrid"
            style={{ transitionDelay: "120ms" }}
          >
            <span className="badge badge--ok">
              <span className="dot" /> Enrolling — capped at 6 people
            </span>
            <h3 className="mt-6">AI Builder Cohort</h3>
            <p className="mt-2 text-sm" style={{ color: "var(--xl-text-faint)" }}>
              Learn it, week by week.
            </p>
            <div className="stat mt-6">
              <div className="stat-value">
                $495<em>/month</em>
              </div>
            </div>
            <ul className="mt-6 space-y-2 text-sm">
              <li>Weekly one-hour live group session</li>
              <li>Maximum 6 people — everyone builds, nobody hides</li>
              <li>Learn AI step by step, on your real work</li>
              <li>
                If the current cohort is full, you start with the next one.
              </li>
            </ul>
            <div className="mt-8">
              <CheckoutButton offering="cohort">
                Join the cohort — $495/month
              </CheckoutButton>
            </div>
            <p className="mt-4 text-xs" style={{ color: "var(--xl-text-faint)" }}>
              Auto-renews monthly · cancel anytime, effective at the end of
              the billing period · Stripe-hosted checkout.
            </p>
          </div>
        </div>

        {/* Zero-risk path, directly under the prices */}
        <div className="panel--raised panel mt-6 text-center">
          <p className="mx-auto max-w-none text-sm">
            Not ready to buy? Watch our free May webinar first —{" "}
            <a href={WEBINAR_URL} target="_blank" rel="noopener noreferrer">
              AI in the Workplace: Productivity Opportunities and Cybersecurity
              Risks
            </a>{" "}
            (75 people signed up live) — or see the{" "}
            <a href={RECAP_URL} target="_blank" rel="noopener noreferrer">
              60-second recap
            </a>{" "}
            of our June 18 workshop.
          </p>
        </div>
      </section>

      <hr className="rule rule--glow" />

      {/* Objection handling */}
      <section>
        <div className="mb-12 text-center">
          <span className="sys-label sys-label--center">
            The Smart and Safe Way
          </span>
          <h2 className="mt-6">The questions everyone asks</h2>
        </div>
        <div className="grid gap-6 sm:grid-cols-3">
          <div className="panel rise">
            <h3>&ldquo;Is this secure?&rdquo;</h3>
            <p className="mt-4 text-sm">
              We&apos;re a managed-IT provider first — cybersecurity is our
              day job, not an afterthought. Our May webinar covered AI
              productivity and its security risks in the same hour, because
              you can&apos;t teach one without the other.
            </p>
          </div>
          <div className="panel rise" style={{ transitionDelay: "100ms" }}>
            <h3>&ldquo;Is this real or hype?&rdquo;</h3>
            <p className="mt-4 text-sm">
              Judge for yourself: <Link href="/work">six running systems</Link>{" "}
              we built with AI, including the site you&apos;re on. We teach
              what we practice.
            </p>
          </div>
          <div className="panel rise" style={{ transitionDelay: "200ms" }}>
            <h3>&ldquo;Am I technical enough?&rdquo;</h3>
            <p className="mt-4 text-sm">
              AI Builders are knowledge workers, not engineers. If you can
              describe your workflow, you can learn to automate it — that&apos;s
              the whole point of the sessions.
            </p>
          </div>
        </div>
      </section>

      {/* Talk to a human */}
      <section className="beams panel--void relative overflow-hidden text-center">
        <div className="relative z-10 mx-auto max-w-2xl px-6">
          <span className="sys-label sys-label--sand sys-label--center">
            Human Channel
          </span>
          <h2 className="mt-8">Not sure which fits?</h2>
          <p className="mx-auto mt-6">
            Talk it through with the XL.net team — we&apos;ll point you to the
            right format, or tell you honestly if neither fits yet.
          </p>
          <Link href="/contact" className="btn btn--sand mt-10 no-underline">
            Talk to us
          </Link>
        </div>
      </section>
    </div>
  );
}
