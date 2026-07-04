import Link from "next/link";

export default function HomePage() {
  return (
    <div className="space-y-24">
      {/* Hero — aurora sky, drifting dust, monumental caps */}
      <section className="aurora horizon relative overflow-hidden px-6 py-28 text-center">
        <xl-dust
          density="36"
          style={{ position: "absolute", inset: 0 }}
          aria-hidden="true"
        />
        <div className="relative z-10 mx-auto max-w-3xl">
          <span className="sys-label">XL.net / Artificial Intelligence</span>
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
          <span className="sys-label">Capabilities</span>
          <h2 className="mt-6">Our AI Systems</h2>
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
              Meet <strong>Tron Netter</strong> — our AI assistant. Try the
              chat in the corner, or call{" "}
              <a href="tel:+18723504325" className="mono">
                (872) 350-4325
              </a>{" "}
              to speak with it directly.
            </p>
          </div>
        </div>
      </section>

      {/* CTA — void panel under light beams, the one warm action */}
      <section className="beams panel--void relative overflow-hidden text-center">
        <div className="relative z-10 mx-auto max-w-2xl px-6">
          <span className="sys-label sys-label--sand">Transmission</span>
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
