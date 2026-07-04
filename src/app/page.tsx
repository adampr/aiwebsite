import Link from "next/link";

export default function HomePage() {
  return (
    <div className="space-y-16">
      {/* Hero */}
      <section className="mx-auto max-w-3xl pt-12 text-center">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
          Artificial Intelligence at{" "}
          <span className="text-[var(--xl-primary)]">XL.net</span>
        </h1>
        <p className="mt-6 text-lg text-neutral-600 dark:text-neutral-400">
          Discover how XL.net harnesses AI to transform managed IT services,
          automate operations, and deliver smarter outcomes for small and
          mid-size businesses across Chicago.
        </p>
        <div className="mt-8 flex justify-center gap-4">
          <Link href="/contact" className="btn-primary inline-block no-underline">
            Get in Touch
          </Link>
          <a
            href="https://xl.net"
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary inline-block no-underline"
          >
            Visit XL.net
          </a>
        </div>
      </section>

      {/* Stats */}
      <section className="mx-auto max-w-4xl">
        <div className="grid gap-6 sm:grid-cols-3">
          <div className="card p-6 text-center">
            <p className="text-3xl font-bold text-[var(--xl-primary)]">79.8%</p>
            <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
              Reduction in IT issues
            </p>
          </div>
          <div className="card p-6 text-center">
            <p className="text-3xl font-bold text-[var(--xl-primary)]">24/7</p>
            <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
              AI-powered support
            </p>
          </div>
          <div className="card p-6 text-center">
            <p className="text-3xl font-bold text-[var(--xl-primary)]">99.3%</p>
            <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
              Customer satisfaction
            </p>
          </div>
        </div>
      </section>

      {/* AI Showcase Placeholder */}
      <section className="mx-auto max-w-4xl">
        <h2 className="mb-6 text-center text-2xl font-bold">
          Our AI Capabilities
        </h2>
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="card p-6">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--xl-primary)] text-white">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 2a4 4 0 0 1 4 4v1a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2V6a4 4 0 0 1 4-4z" />
                <path d="M9 18h6M12 14v4" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold">AI Service Desk</h3>
            <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
              Intelligent ticket triage, automated resolution, and proactive
              issue detection powered by machine learning.
            </p>
          </div>
          <div className="card p-6">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--xl-primary)] text-white">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold">AI-Driven Security</h3>
            <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
              Continuous threat monitoring, anomaly detection, and automated
              incident response safeguarding your infrastructure.
            </p>
          </div>
          <div className="card p-6">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--xl-primary)] text-white">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                <line x1="12" y1="22.08" x2="12" y2="12" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold">Predictive Analytics</h3>
            <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
              Data-driven insights that anticipate system failures, optimize
              performance, and reduce downtime before it impacts your business.
            </p>
          </div>
          <div className="card p-6">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--xl-primary)] text-white">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold">Conversational AI</h3>
            <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
              Meet Tron Netter — our AI assistant. Try the chat widget in the
              bottom right to see conversational AI in action.
            </p>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-3xl rounded-xl border border-[var(--xl-primary)] bg-[var(--xl-primary)]/5 p-8 text-center dark:bg-[var(--xl-primary)]/10">
        <h2 className="text-2xl font-bold">
          Ready to see what AI can do for your business?
        </h2>
        <p className="mt-3 text-neutral-600 dark:text-neutral-400">
          Get in touch to learn how XL.net&apos;s AI-powered solutions can
          transform your IT operations.
        </p>
        <Link href="/contact" className="btn-cta mt-6 inline-block no-underline">
          Contact Us
        </Link>
      </section>
    </div>
  );
}
