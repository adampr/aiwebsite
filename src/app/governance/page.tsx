import type { Metadata } from "next";
import Link from "next/link";
import { readSession } from "@aicompany/core/auth/session";
import { siteConfig } from "site.config";
import {
  CONSUMER_EMAIL_DOMAINS,
  NOT_LEGAL_ADVICE_LINE,
} from "@/lib/governance/config";
import { GovernanceHome } from "@/components/governance/home";

// Signed-out visitors get the crawlable pitch + sign-in panel (never a
// redirect); signed-in users get the project list + create panel.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "AI Governance",
  description:
    "Draft an AI usage policy or a full governance document set mapped to NIST AI RMF, the EU AI Act, or ISO/IEC 42001. Tron researches your company first and drafts with you, live.",
  alternates: { canonical: "/governance" },
};

const faint = { color: "var(--xl-text-faint)" } as const;

export default async function GovernancePage() {
  const session = await readSession(siteConfig);

  if (!session) {
    return (
      <div className="mx-auto max-w-5xl space-y-16">
        <section className="pt-8 text-center">
          <span className="sys-label sys-label--center">
            Home / AI Governance
          </span>
          <h1 className="mt-8">
            Governance, drafted <span className="glow">with you</span>
          </h1>
          <p className="mx-auto mt-6 max-w-3xl text-lg">
            Work with Tron Netter to draft an AI usage policy your people will
            actually read, or a full governance set mapped to NIST AI RMF, the
            EU AI Act, or ISO/IEC 42001. Tron researches your company first,
            asks you the questions that matter, and the document takes shape
            on screen as you answer.
          </p>
        </section>

        <hr className="horizon" />

        <section className="grid gap-6 sm:grid-cols-3">
          <div className="panel rise">
            <h3>Researched, not generic</h3>
            <p className="mt-4 text-sm">
              Before the first question, Tron reads your website, what the web
              says about you, and your industry. The draft starts from your
              reality, not a template.
            </p>
          </div>
          <div className="panel rise" style={{ transitionDelay: "100ms" }}>
            <h3>Current standards</h3>
            <p className="mt-4 text-sm">
              Built on the current text of NIST AI RMF, the EU AI Act, and
              ISO/IEC 42001. Tron re-checks all three every quarter.
            </p>
          </div>
          <div className="panel rise" style={{ transitionDelay: "200ms" }}>
            <h3>Yours, then gone</h3>
            <p className="mt-4 text-sm">
              Download Word-friendly documents anytime. We delete your project
              30 days after your last activity, drafts and research included.
            </p>
          </div>
        </section>

        <section className="mx-auto max-w-xl">
          <div className="panel panel--lightline text-center">
            <h3>Sign in to start</h3>
            <p className="mx-auto mt-4 text-sm">
              Projects are tied to your account and your company domain. Sign
              in with Google or Microsoft; you will be back here in seconds.
            </p>
            <Link
              href="/login?redirect=/governance"
              className="btn btn--primary mt-6 no-underline"
            >
              Sign in to continue
            </Link>
          </div>
          <p className="mt-6 text-center text-xs" style={faint}>
            {NOT_LEGAL_ADVICE_LINE}
          </p>
        </section>
      </div>
    );
  }

  const emailDomain = session.email.split("@")[1]?.toLowerCase() ?? "";
  const defaultDomain = CONSUMER_EMAIL_DOMAINS.has(emailDomain)
    ? ""
    : emailDomain;

  return (
    <div className="mx-auto max-w-5xl space-y-12">
      <section className="pt-8 text-center">
        <span className="sys-label sys-label--center">AI Governance</span>
        <h1 className="mt-6">
          Your governance <span className="glow">projects</span>
        </h1>
        <p className="mx-auto mt-4 max-w-3xl">
          Tron researches your company first, asks the questions that matter,
          and drafts live as you answer.
        </p>
      </section>

      <GovernanceHome defaultDomain={defaultDomain} />

      <p className="text-center text-xs" style={faint}>
        {NOT_LEGAL_ADVICE_LINE}
      </p>
    </div>
  );
}
