import type { Metadata } from "next";
import Link from "next/link";

// Homepage metadata (2026-08-05 redesign): absolute title so the layout's
// "%s | XL.net AI" template does not apply; 46 chars rendered. Description
// 158 chars. Canonical "/" is inherited from the root layout's alternates.
export const metadata: Metadata = {
  title: {
    absolute: "AI for Managed IT, Built in the Open by XL.net",
  },
  description:
    "The AI lab of XL.net, Chicago managed IT: real AI systems built in the open, a free AI governance writer, AI Builders training, and Tron Netter, our AI agent.",
  openGraph: {
    title: "AI for Managed IT, Built in the Open by XL.net",
    description:
      "The AI lab of XL.net, Chicago managed IT: real AI systems built in the open, a free AI governance writer, AI Builders training, and Tron Netter, our AI agent.",
    type: "website",
    locale: "en_US",
    siteName: "XL.net AI",
    images: ["/xl-icon-512.png"],
  },
};

export default function HomePage() {
  return (
    <div className="space-y-24">
      {/* Hero: aurora sky, drifting dust, the animated brand lockup */}
      <section className="aurora relative overflow-hidden px-6 pb-32 pt-28 text-center">
        <xl-dust
          density="36"
          style={{ position: "absolute", inset: 0 }}
          aria-hidden="true"
        />
        <div className="relative z-10 mx-auto max-w-3xl">
          <iframe
            src="/brand/xl-logo-animated-dark.html"
            title="XL.net animated logo"
            aria-hidden="true"
            tabIndex={-1}
            scrolling="no"
            style={{ colorScheme: "dark" }}
            className="theme-dark-only pointer-events-none mx-auto h-[190px] w-full max-w-[640px] border-0"
          />
          <iframe
            src="/brand/xl-logo-animated-light.html"
            title="XL.net animated logo"
            aria-hidden="true"
            tabIndex={-1}
            scrolling="no"
            style={{ colorScheme: "light" }}
            className="theme-light-only pointer-events-none mx-auto h-[190px] w-full max-w-[640px] border-0"
          />
          <span className="sys-label sys-label--center mt-4">
            The AI Lab of XL.net
          </span>
          <h1 className="mt-8">
            AI for managed IT,{" "}
            <span className="glitch glow" data-text="built in the open">
              built in the open
            </span>
          </h1>
          <p className="mx-auto mt-8 text-lg">
            This is where XL.net, a Chicago managed-IT company, builds with AI
            and shows the results: the systems we run, the governance documents
            we help you write, the training we teach, and the agent that
            answers our phone. Everything here is real and running, including
            the site you are reading. Tour it, use it, or ask Tron Netter about
            any of it, 24/7.
          </p>
          <div className="mt-12 flex flex-wrap justify-center gap-6">
            <Link href="/work" className="btn btn--primary no-underline">
              Tour Our Work
            </Link>
            <Link href="/contact" className="btn no-underline">
              Talk to Tron Netter
            </Link>
          </div>
        </div>
      </section>

      {/* Horizon: glowing line with the traveling light sweep */}
      <hr className="horizon mx-auto max-w-6xl" />

      {/* Stats: the three XL.net numbers, verbatim, monumental */}
      <section className="mx-auto max-w-4xl px-6">
        <div className="grid gap-12 text-center sm:grid-cols-3">
          <div className="stat rise">
            <div className="stat-value">
              79.8<em>%</em>
            </div>
            <div className="stat-label">Reduction in IT issues</div>
          </div>
          <div className="stat rise" style={{ transitionDelay: "120ms" }}>
            <div className="stat-value">
              24<em>/7</em>
            </div>
            <div className="stat-label">AI-powered support</div>
          </div>
          <div className="stat rise" style={{ transitionDelay: "240ms" }}>
            <div className="stat-value">
              99.3<em>%</em>
            </div>
            <div className="stat-label">Customer satisfaction</div>
          </div>
        </div>
      </section>

      <hr className="rule rule--glow mx-auto max-w-5xl" />

      {/* What runs here: the five public surfaces, each real, each linked */}
      <section className="mx-auto max-w-5xl px-6">
        <div className="mb-12 text-center">
          <span className="sys-label sys-label--center">The Surfaces</span>
          <h2 className="shimmer mt-6">What runs here</h2>
          <p className="mx-auto mt-6 max-w-2xl">
            Five working surfaces, not a brochure. Each one is live today, and
            each one links to the real thing.
          </p>
        </div>

        {/* Flagship: the exhibit hall, full width */}
        <div className="panel panel--lightline rise mb-6">
          <span className="sys-label">Exhibit Hall</span>
          <h3 className="mt-4">Our Work: a tour of the lab</h3>
          <p className="mt-4 text-sm">
            Everything on our work floor is real and running: the Software
            Brain, the conversation-first AI engine behind every exhibit; the
            @aicompany/core middleware that wraps an AI persona and a whole
            working site around one config file; client-delivery platforms;
            our autonomy experiments; and tools our own team builds and
            submits. The site you are reading is one of the exhibits.
          </p>
          <Link href="/work" className="btn btn--text mt-6 no-underline">
            Tour the exhibit hall →
          </Link>
        </div>

        <div className="grid gap-6 sm:grid-cols-2">
          <div className="panel rise">
            <span className="sys-label">Free Tool</span>
            <h3 className="mt-4">AI Governance Writer</h3>
            <p className="mt-4 text-sm">
              Tron Netter reads your website before the first question, then
              interviews you one question at a time and drafts an AI acceptable
              use policy, an FFIEC-aligned bank AI policy suite, or
              working-draft document sets mapped to NIST AI RMF, the EU AI Act,
              or ISO/IEC 42001. Free: sign in with Google or Microsoft, and the
              documents are yours in Word, watermarked DRAFT until you confirm
              the final.
            </p>
            <Link
              href="/governance"
              className="btn btn--text mt-6 no-underline"
            >
              Start a governance draft →
            </Link>
          </div>

          <div className="panel rise" style={{ transitionDelay: "100ms" }}>
            <span className="sys-label">For Your Company</span>
            <h3 className="mt-4">Your AI Roadmap</h3>
            <p className="mt-4 text-sm">
              A private portal for your whole company: six steps from an AI
              governance document on file to a scorecard of the builders on
              your team. Submit AI-built work and an automated editorial panel
              reviews it, publishing what it can verify to a private work page
              for your company. Four
              steps are free, two are paid training. Sign in with a work email;
              your roadmap is visible only to your company.
            </p>
            <Link href="/roadmap" className="btn btn--text mt-6 no-underline">
              Open your roadmap →
            </Link>
          </div>

          <div className="panel rise" style={{ transitionDelay: "200ms" }}>
            <span className="sys-label sys-label--sand">Now Enrolling</span>
            <h3 className="mt-4">AI Builders training</h3>
            <p className="mt-4 text-sm">
              We believe most knowledge workers will be AI Builders by 2028,
              and we started with ourselves. Learn to build your own AI
              workflows and automations the smart and safe way: a four-hour
              hands-on workshop ($995 one-time, capped at 8 attendees) or a
              weekly cohort hour ($495/month, capped at 6 people), taught by
              the XL.net team.
            </p>
            <Link href="/builders" className="btn btn--text mt-6 no-underline">
              Explore the programs →
            </Link>
          </div>

          <div className="panel rise" style={{ transitionDelay: "300ms" }}>
            <span className="sys-label">Nightly</span>
            <h3 className="mt-4">AI News for Business</h3>
            <p className="mt-4 text-sm">
              Every night Tron Netter reads the AI news and writes up the one
              story a business owner should actually care about. Every article
              discloses that an AI wrote it, and our methodology page documents
              the publication gates, the two-named-sources minimum, and the
              corrections policy.
            </p>
            <div className="mt-6 flex flex-wrap gap-4">
              <Link href="/blog" className="btn btn--text no-underline">
                Read the news →
              </Link>
              <Link
                href="/methodology"
                className="btn btn--text no-underline"
              >
                How it is written →
              </Link>
            </div>
          </div>
        </div>
      </section>

      <hr className="rule rule--glow mx-auto max-w-5xl" />

      {/* Tron Netter: one agent, every channel, doing the actual work */}
      <section className="mx-auto max-w-5xl px-6">
        <div className="panel panel--lightline rise">
          <div className="grid items-center gap-10 md:grid-cols-[1fr_200px]">
            <div>
              <span className="sys-label">One Agent · Every Channel</span>
              <h2 className="mt-6">Meet Tron Netter</h2>
              <p className="mt-6 text-sm">
                Tron Netter is our AI agent: one persona across web chat, text,
                email, and voice. It is not a demo. It runs the governance
                interviews, takes work submissions by email, and writes the
                nightly news, and you can reach it any hour.
              </p>
              <ul className="mt-6 space-y-3 text-sm">
                <li>
                  <span className="mono">Chat</span> · the widget in the corner
                  of every page
                </li>
                <li>
                  <span className="mono">Call or text</span> ·{" "}
                  <a href="tel:+18723504325" className="mono">
                    (872) 350-4325
                  </a>
                  , answered 24/7
                </li>
                <li>
                  <span className="mono">Email</span> ·{" "}
                  <a href="mailto:Tron.Netter@ai.xl.net" className="mono">
                    Tron.Netter@ai.xl.net
                  </a>
                </li>
              </ul>
              <p className="mt-6 text-sm">
                {/* Entity-bearing node kept on one line (SWC rule). */}
                Guardrails by architecture: every email it sends is BCC&apos;d to a human, and its public persona has no tools and no live internet access, so it can never take an action we have not designed.
              </p>
              <Link
                href="/contact"
                className="btn btn--text mt-6 no-underline"
              >
                All the ways to reach it →
              </Link>
            </div>
            <div
              className="radar mx-auto"
              style={{ width: 180 }}
              aria-hidden="true"
            >
              <i className="radar-blip" style={{ left: "62%", top: "34%" }} />
              <i
                className="radar-blip radar-blip--sand"
                style={{ left: "30%", top: "58%", animationDelay: "2s" }}
              />
            </div>
          </div>
        </div>
      </section>

      <hr className="rule rule--glow mx-auto max-w-5xl" />

      {/* Family: the parent company and the sister deployment */}
      <section className="mx-auto max-w-5xl px-6">
        <div className="mb-12 text-center">
          <span className="sys-label sys-label--center">Around the Lab</span>
          <h2 className="mt-6">The company behind it, and the sister site</h2>
        </div>
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="panel rise">
            <span className="badge badge--light mb-4">
              <span className="dot" /> Parent company
            </span>
            <h3 className="mt-4">XL.net</h3>
            <p className="mt-4 text-sm">
              Our parent company delivers managed IT to small and mid-size
              businesses across Chicago, certified to SOC 2 Type II and ISO
              27001:2022. The numbers above are theirs, and this lab exists to
              push that service further with AI.
            </p>
            <a
              href="https://xl.net"
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn--text mt-6 no-underline"
            >
              Visit xl.net →
            </a>
          </div>
          <div className="panel rise" style={{ transitionDelay: "120ms" }}>
            <span className="badge badge--ok mb-4">
              <span className="dot" /> Sister deployment
            </span>
            <h3 className="mt-4">roleplay.xl.net</h3>
            <p className="mt-4 text-sm">
              Our external-tenant experiment: what happens when the Software
              Brain powers a product that is not about XL.net at all. A public
              multi-user AI playground running directly on the Brain SDK, with
              realtime voice, Google sign-in gated by admin approval, and
              isolated per-tenant databases.
            </p>
            <div className="mt-6 flex flex-wrap gap-4">
              <a
                href="https://roleplay.xl.net"
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn--text no-underline"
              >
                Visit roleplay.xl.net →
              </a>
              <Link
                href="/work#roleplay"
                className="btn btn--text no-underline"
              >
                See the exhibit →
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* CTA: void panel under light beams, the one warm action */}
      <section className="beams panel--void relative overflow-hidden text-center">
        <div className="relative z-10 mx-auto max-w-2xl px-6">
          <div
            className="orbit float mx-auto mb-10"
            style={{ width: 180 }}
            aria-hidden="true"
          >
            <i className="orbit-core" />
            <i className="orbit-ring" />
            <i className="orbit-ring orbit-ring--2" />
            <i className="orbit-ring orbit-ring--3" />
          </div>
          <span className="sys-label sys-label--sand sys-label--center">
            Transmission
          </span>
          <h2 className="mt-8">Start where you like</h2>
          <p className="mx-auto mt-6">
            Draft a governance policy for free, open a roadmap for your
            company, learn to build, or just ask Tron Netter what any of this
            means for your business.
          </p>
          <div className="mt-10 flex flex-wrap justify-center gap-6">
            <Link href="/contact" className="btn btn--sand no-underline">
              Contact Us
            </Link>
            <Link href="/work" className="btn no-underline">
              Tour Our Work
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
