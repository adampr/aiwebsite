import type { Metadata } from "next";
import Link from "next/link";
import { CheckoutButton } from "@/components/checkout-button";
import {
  PREVIOUS_SESSION_LABEL,
  WORKSHOP_PRICE_USD,
  WORKSHOP_SEAT_CAP,
  WORKSHOP_SESSION_LABEL,
  WORKSHOP_SESSION_LONG_LABEL,
  WORKSHOP_TICKETS_URL,
  workshopWindow,
} from "@/lib/workshop/session";

export const metadata: Metadata = {
  title: "AI Builders: Learn to Build AI Workflows Safely",
  description:
    "Become an AI Builder: learn to build your own AI workflows and automations the smart, safe way, taught by the XL.net team. Weekly cohort or four-hour workshop.",
  alternates: { canonical: "/builders" },
  openGraph: {
    title: "AI Builders: Learn to Build AI Workflows Safely | XL.net AI",
    description:
      "Become an AI Builder: learn to build your own AI workflows and automations the smart, safe way, taught by the XL.net team. Weekly cohort or four-hour workshop.",
  },
};

// The workshop card renders three time windows (src/lib/workshop/session.ts,
// the one source of truth for dates, price, cap and the Ticket Tailor URL)
// so the page never advertises a past event: until August 27 8:00 AM CT it
// shows that session SOLD OUT above the bookable September 24 one
// ("prev-sold-out"); from then until September 24 8:00 AM CT only the
// September 24 session ("booking"); afterwards a "next date TBA" state whose
// primary CTA is /builders/notify, the notification list. In the two booking
// windows the primary CTA is the Ticket Tailor event page (single seat pool)
// and the notification list is the secondary path for people who cannot make
// the date. 8:00 AM CT = 13:00 UTC (CDT). Requires dynamic rendering, per
// request Date.now(); do not remove force-dynamic.
export const dynamic = "force-dynamic";

// Self-hosted copy of the May 21 Zoom webinar recording (54 min, 136 MB).
// The file is gitignored; it lives in public/media/ on the dev box and ships
// to the VM via deploy.sh's repo rsync (like data/GeoLite2, but in-tree).
const WEBINAR_URL = "/media/ai-in-the-workplace-webinar-2026-05.mp4";
const RECAP_URL = "https://youtube.com/shorts/XFpJpTT4_MI";

export default function BuildersPage() {
  // eslint-disable-next-line react-hooks/purity -- force-dynamic server page; per-request clock read is the point
  const now = Date.now();
  const phase = workshopWindow(now);
  const booking = phase !== "tba";

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
          by 2028, and we started with ourselves.{" "}
          <Link href="/work">See what we&apos;ve built</Link>, then learn to
          build your own, the smart and safe way.
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
          {/* Workshop, primary. id + scroll-mt: /roadmap step 03 deep-links
              here (config.ts href "/builders#workshop"). */}
          <div
            id="workshop"
            className="panel panel--lightline rise min-w-0 scroll-mt-24 sm:row-span-7 sm:grid sm:grid-rows-subgrid"
          >
            {/* Exactly ONE subgrid child per branch here (the stacked strips
                share a wrapper): each card has 7 children and the
                grid-rows-[...] template + row-span-7 depend on that count. */}
            {phase === "prev-sold-out" ? (
              // Sold-out strip has no dot: the breathing dot is the "live,
              // bookable" signal and belongs only on the open session. The
              // strips stack (side by side they overflow the ~412px card
              // interior) and the column flex stretches both full width,
              // matching the cohort card's stretched grid-item badge (no
              // self-start here: on a flex-column child it would shrink the
              // strip to content width).
              <div className="flex flex-col gap-2">
                <span className="badge badge--warn badge--wrap">
                  {PREVIOUS_SESSION_LABEL} · Sold out
                </span>
                <span className="badge badge--light badge--wrap">
                  <span className="dot" /> {WORKSHOP_SESSION_LABEL} · Booking open
                </span>
              </div>
            ) : phase === "booking" ? (
              <span className="badge badge--light badge--wrap self-start">
                <span className="dot" /> {WORKSHOP_SESSION_LABEL} · Booking open
              </span>
            ) : (
              <span className="badge badge--light badge--wrap self-start">
                <span className="dot" /> Next date: TBA
              </span>
            )}
            <h3 className="mt-6">AI Builders Workshop</h3>
            <p className="mt-2 text-sm" style={{ color: "var(--xl-text-faint)" }}>
              Build real workflows in one morning.
            </p>
            <div className="stat mt-6">
              <div className="stat-value">
                ${WORKSHOP_PRICE_USD}<em> one-time</em>
              </div>
            </div>
            {booking ? (
              <ul className="mt-6 space-y-2 text-sm">
                <li>
                  {WORKSHOP_SESSION_LONG_LABEL} · 8:00 AM to 12:00 PM CT, live
                  on Zoom
                </li>
                <li>Four hours online, hands-on, not a lecture</li>
                <li>Build real AI workflows and automations you keep</li>
                <li>
                  Capped at {WORKSHOP_SEAT_CAP} attendees · July 30 and August
                  27 both sold out
                </li>
                <li>
                  Can&apos;t make {WORKSHOP_SESSION_LABEL}?{" "}
                  <Link href="/builders/notify">Join the notification list</Link>{" "}
                  and we&apos;ll email you when the date after it is set.
                </li>
              </ul>
            ) : (
              <ul className="mt-6 space-y-2 text-sm">
                <li>Four hours online, hands-on, not a lecture</li>
                <li>Build real AI workflows and automations you keep</li>
                <li>Next session being scheduled now</li>
                <li>
                  Capped at {WORKSHOP_SEAT_CAP} attendees · July 30 and August
                  27 both sold out
                </li>
                <li>
                  Missed the seats?{" "}
                  <Link href="/builders/notify">Join the notification list</Link>{" "}
                  and we&apos;ll email you when the next date is set.
                </li>
              </ul>
            )}
            <div className="mt-8">
              {booking ? (
                <a
                  href={WORKSHOP_TICKETS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn--primary btn--wrap no-underline"
                >
                  Reserve {WORKSHOP_SESSION_LABEL} · ${WORKSHOP_PRICE_USD}
                </a>
              ) : (
                <Link
                  href="/builders/notify"
                  className="btn btn--primary btn--wrap no-underline"
                >
                  Get notified about the next session
                </Link>
              )}
            </div>
            {booking ? (
              <p className="mt-4 text-xs" style={{ color: "var(--xl-text-faint)" }}>
                One-time · {WORKSHOP_SEAT_CAP} seats · checkout on Ticket Tailor
                · Zoom link sent at registration
              </p>
            ) : (
              <p className="mt-4 text-xs" style={{ color: "var(--xl-text-faint)" }}>
                Free to join · sign in required · remove yourself anytime.
              </p>
            )}
          </div>

          {/* Cohort. id + scroll-mt: /roadmap step 08 deep-links here. */}
          <div
            id="cohort"
            className="panel rise min-w-0 scroll-mt-24 sm:row-span-7 sm:grid sm:grid-rows-subgrid"
            style={{ transitionDelay: "120ms" }}
          >
            {/* self-start (here and on the workshop badge) stops the subgrid
                from stretching a badge to the taller card's row height. */}
            <span className="badge badge--ok badge--wrap self-start">
              <span className="dot" /> Enrolling · capped at 6 people
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
              <li>Maximum 6 people: everyone builds, nobody hides</li>
              <li>Learn AI step by step, on your real work</li>
              <li>
                If the current cohort is full, you start with the next one.
              </li>
            </ul>
            <div className="mt-8">
              <CheckoutButton
                offering="cohort"
                className="btn btn--primary btn--wrap"
              >
                Join the cohort · $495/month
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
            Not ready to buy? Watch our free May webinar first,{" "}
            <a href={WEBINAR_URL} target="_blank" rel="noopener noreferrer">
              AI in the Workplace: Productivity Opportunities and Cybersecurity
              Risks
            </a>{" "}
            (75 people signed up live), or see the{" "}
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
              We&apos;re a managed-IT provider first; cybersecurity is our
              day job, not an afterthought. Our May webinar covered AI
              productivity and its security risks in the same hour, because
              you can&apos;t teach one without the other.
            </p>
          </div>
          <div className="panel rise" style={{ transitionDelay: "100ms" }}>
            <h3>&ldquo;Is this real or hype?&rdquo;</h3>
            <p className="mt-4 text-sm">
              Judge for yourself: <Link href="/work">the running systems</Link>{" "}
              we built with AI, including the site you&apos;re on. We teach
              what we practice.
            </p>
          </div>
          <div className="panel rise" style={{ transitionDelay: "200ms" }}>
            <h3>&ldquo;Am I technical enough?&rdquo;</h3>
            <p className="mt-4 text-sm">
              AI Builders are knowledge workers, not engineers. If you can
              describe your workflow, you can learn to automate it; that&apos;s
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
            Talk it through with the XL.net team; we&apos;ll point you to the
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
