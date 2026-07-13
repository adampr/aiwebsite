import Link from "next/link";

export default function HomePage() {
  return (
    <div className="space-y-24">
      {/* Hero — aurora sky, drifting dust, monumental caps */}
      <section className="aurora relative overflow-hidden px-6 pb-36 pt-28 text-center">
        <xl-dust
          density="36"
          style={{ position: "absolute", inset: 0 }}
          aria-hidden="true"
        />
        <div className="relative z-10 mx-auto max-w-3xl">
          {/* Animated brand lockup — self-contained embeds, theme-aware */}
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
            Artificial Intelligence
          </span>
          <h1 className="mt-8">
            Intelligence at{" "}
            <span className="glitch glow" data-text="XL.NET">
              XL.NET
            </span>
          </h1>
          <p className="mx-auto mt-8 text-lg">
            Discover how XL.net harnesses AI to transform managed IT services,
            automate operations, and deliver smarter outcomes for small and
            mid-size businesses across Chicago.
          </p>
          <div className="mt-12 flex flex-wrap justify-center gap-6">
            <Link href="/contact" className="btn btn--primary no-underline">
              Get in Touch
            </Link>
            <a
              href="https://xl.net"
              target="_blank"
              rel="noopener noreferrer"
              className="btn no-underline"
            >
              Visit XL.net
            </a>
          </div>
        </div>
      </section>

      {/* Horizon — glowing line with the traveling light sweep */}
      <hr className="horizon mx-auto max-w-6xl" />

      {/* Stats — monumental numerals over whisper labels */}
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

      {/* Capabilities — hairline panels with a lightline lead */}
      <section className="mx-auto max-w-5xl px-6">
        <div className="mb-12 text-center">
          <span className="sys-label sys-label--center">Capabilities</span>
          <h2 className="shimmer mt-6">Our AI Systems</h2>
        </div>
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="panel panel--lightline rise">
            <span className="badge badge--light mb-4">
              <span className="dot" /> Online
            </span>
            <h3 className="mt-4">AI Service Desk</h3>
            <p className="mt-4 text-sm">
              Intelligent ticket triage, automated resolution, and proactive
              issue detection powered by machine learning.
            </p>
          </div>
          <div className="panel rise" style={{ transitionDelay: "100ms" }}>
            <span className="badge badge--ok mb-4">
              <span className="dot" /> Monitoring
            </span>
            <h3 className="mt-4">AI-Driven Security</h3>
            <p className="mt-4 text-sm">
              Continuous threat monitoring, anomaly detection, and automated
              incident response safeguarding your infrastructure.
            </p>
            <div
              className="radar mx-auto mt-6"
              style={{ width: 150 }}
              aria-hidden="true"
            >
              <i className="radar-blip" style={{ left: "62%", top: "34%" }} />
              <i
                className="radar-blip radar-blip--sand"
                style={{ left: "30%", top: "58%", animationDelay: "2s" }}
              />
            </div>
          </div>
          <div className="panel rise" style={{ transitionDelay: "200ms" }}>
            <span className="badge mb-4">
              <span className="dot" /> Forecasting
            </span>
            <h3 className="mt-4">Predictive Analytics</h3>
            <p className="mt-4 text-sm">
              Data-driven insights that anticipate system failures, optimize
              performance, and reduce downtime before it impacts your business.
            </p>
          </div>
          <div className="panel rise" style={{ transitionDelay: "300ms" }}>
            <span className="badge badge--light mb-4">
              <span className="dot" /> Live 24/7
            </span>
            <h3 className="mt-4">Conversational AI</h3>
            <p className="mt-4 text-sm">
              Meet <strong>Tron Netter</strong>, our AI assistant. Try the
              chat in the corner, or call{" "}
              <a href="tel:+18723504325" className="mono">
                (872) 350-4325
              </a>{" "}
              to speak with it directly.
            </p>
          </div>
        </div>
      </section>

      <hr className="rule rule--glow mx-auto max-w-5xl" />

      {/* Work + Builders teasers */}
      <section className="mx-auto max-w-5xl px-6">
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="panel panel--lightline rise">
            <span className="sys-label">Exhibit Hall</span>
            <h3 className="mt-4">See what we&apos;ve built</h3>
            <p className="mt-4 text-sm">
              Ten real, running AI systems: an AI engine, reusable
              middleware, two production sites, client-delivery platforms,
              and the access layers behind them, plus our autonomy
              experiments. Including the site you&apos;re reading.
            </p>
            <Link href="/work" className="btn btn--text mt-6 no-underline">
              Tour our work →
            </Link>
          </div>
          <div className="panel rise" style={{ transitionDelay: "120ms" }}>
            <span className="sys-label sys-label--sand">Now Enrolling</span>
            <h3 className="mt-4">Become an AI Builder</h3>
            <p className="mt-4 text-sm">
              Learn to build your own AI workflows and automations, the smart
              and safe way. Weekly cohort ($495/mo, capped at 6) or a
              four-hour hands-on workshop ($995).
            </p>
            <Link href="/builders" className="btn btn--text mt-6 no-underline">
              Explore the programs →
            </Link>
          </div>
        </div>
      </section>

      {/* CTA — void panel under light beams, the one warm action */}
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
          <h2 className="mt-8">
            Ready to see what AI can do for your business?
          </h2>
          <p className="mx-auto mt-6">
            Get in touch to learn how XL.net&apos;s AI-powered solutions can
            transform your IT operations.
          </p>
          <Link
            href="/contact"
            className="btn btn--sand mt-10 no-underline"
          >
            Contact Us
          </Link>
        </div>
      </section>
    </div>
  );
}
