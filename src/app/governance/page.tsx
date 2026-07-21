import type { Metadata } from "next";
import Link from "next/link";
import { readSession } from "@aicompany/core/auth/session";
import { siteConfig } from "site.config";
import {
  CONSUMER_EMAIL_DOMAINS,
  NOT_LEGAL_ADVICE_LINE,
} from "@/lib/governance/config";
import { GovernanceHome } from "@/components/governance/home";

// Signed-out visitors get the crawlable showcase + sign-in ask (never a
// redirect); signed-in users get the project list + create panel.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  // Absolute: the layout template's " | XL.net AI" suffix would push the
  // framework names past SERP truncation (~60 chars).
  title: {
    absolute: "Free AI Governance Builder | NIST AI RMF, EU AI Act, ISO 42001",
  },
  description:
    "Free AI governance builder: draft an AI acceptable use policy (AI usage policy), an FFIEC-aligned bank AI policy suite, or a document set for NIST AI RMF, the EU AI Act, or ISO/IEC 42001.",
  alternates: { canonical: "/governance" },
};

const faint = { color: "var(--xl-text-faint)" } as const;
const warn = { color: "var(--xl-warn)" } as const;

// References the site's existing Organization node (OrgJsonLdScript in
// layout.tsx mints `${baseUrl}/#org`) instead of minting a second entity.
const appJsonLd = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "AI Governance Builder",
  url: `${siteConfig.site.baseUrl}/governance`,
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web",
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  provider: { "@type": "Organization", "@id": `${siteConfig.site.baseUrl}/#org` },
  description:
    "Draft an AI acceptable use policy (AUP), an FFIEC-aligned bank AI policy suite, or a governance document set mapped to NIST AI RMF, the EU AI Act, or ISO/IEC 42001. Tron Netter researches your company first and drafts with you, live.",
}).replace(/</g, "\\u003c");

const SESSION_STEPS = [
  {
    num: "01",
    title: "A researched first guess",
    body: "Before the first question, Tron reads your website, what the web says about you, and your industry, then shows you who it thinks you are. You correct that snapshot, and the draft starts from your reality instead of a template.",
  },
  {
    num: "02",
    title: "One question at a time",
    body: "No forty-field intake form. Tron asks one question, offers tappable suggestions when they help, and moves on. You can change any earlier answer at any time.",
  },
  {
    num: "03",
    title: "The draft takes shape on screen",
    body: "After every answer, the document redrafts in front of you. Sections appear and tighten as the interview goes on, so you watch the draft take shape instead of waiting for a big reveal at the end.",
  },
  {
    num: "04",
    title: "Nothing silently accepted",
    body: "Anything Tron assumed is a visible TO CONFIRM item in the draft. A final cannot exist while one remains: you resolve each with a typed fact or an explicit keep-as-drafted.",
  },
] as const;

const FAQ = [
  {
    q: "Is it really free?",
    a: "Yes. Sign in with a Google or Microsoft account and draft a policy or a full document set at no cost. No card, no trial clock.",
  },
  {
    q: "Is this legal advice?",
    a: "No. You get working drafts for your leadership and counsel to review, and every download says so on its first page.",
  },
  {
    q: "Why do I have to sign in?",
    a: "Projects are tied to your account and your company domain, so your drafts persist between visits and belong to you. Sign-in takes seconds with Google or Microsoft.",
  },
  {
    q: "What happens to my data?",
    a: "Your project is deleted 30 days after your last activity, drafts and research included, and every visit resets that clock. You can download everything before then.",
  },
  {
    q: "What if Tron gets something wrong?",
    a: "Anything Tron assumed stays flagged in the draft until you resolve it yourself, and you can change any earlier answer or reopen a finished draft at any time.",
  },
] as const;

export default async function GovernancePage() {
  const session = await readSession(siteConfig);

  if (!session) {
    return (
      <div className="mx-auto max-w-5xl space-y-16">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: appJsonLd }}
        />

        <section className="pt-8 text-center">
          <span className="sys-label sys-label--center">
            Home / AI Governance
          </span>
          <h1 className="mt-8">
            AI governance, drafted <span className="glow">with you</span>
          </h1>
          <p className="mx-auto mt-6 max-w-3xl text-lg">
            Tron Netter researches your company before asking a single
            question, then interviews you one question at a time while the
            document takes shape on screen. Free, shaped to your business,
            and yours in Word at any point.
          </p>
          <div className="mt-10 flex flex-wrap justify-center gap-6">
            <Link
              href="/login?redirect=/governance"
              className="btn btn--primary no-underline"
            >
              Sign in and start free
            </Link>
            <a href="#how" className="btn no-underline">
              See how it works
            </a>
          </div>
          <p className="mono mx-auto mt-6 max-w-2xl text-xs" style={faint}>
            free · sign in with Google or Microsoft · deleted 30 days after
            your last activity
          </p>
        </section>

        <hr className="horizon" />

        <section id="how">
          <div className="text-center">
            <span className="sys-label sys-label--center">The Session</span>
            <h2 className="mt-6">First, Tron researches you</h2>
          </div>
          <div className="mt-12 grid items-start gap-10 md:grid-cols-2">
            <div className="space-y-6">
              {SESSION_STEPS.map((step) => (
                <div
                  key={step.num}
                  className="border-t border-[var(--xl-line)] pt-4"
                >
                  <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
                    <span className="text-faint">{step.num} · </span>
                    {step.title}
                  </h3>
                  <p className="mt-3 max-w-none text-sm">{step.body}</p>
                </div>
              ))}
            </div>
            <div className="panel panel--raised">
              <span className="sys-label">Representative session</span>
              <p className="mono mt-6 max-w-none text-xs text-faint">
                research snapshot · corrected by you
              </p>
              <p className="mt-4 max-w-none text-sm">
                <strong>
                  Who reviews AI output before it reaches a client?
                </strong>
              </p>
              <div className="mt-4 flex flex-wrap gap-3">
                <span className="badge badge--light">Account manager</span>
                <span className="badge">Team lead</span>
                <span className="badge">No review today</span>
              </div>
              <p className="mono mt-2 max-w-none text-xs text-faint">
                tap a suggestion or type your own
              </p>
              <p className="mono mt-6 max-w-none text-xs text-faint">
                redrafting section 4 · Human oversight
              </p>
              <div className="mt-4 border-t border-[var(--xl-line)] pt-3">
                <p className="mono max-w-none text-xs" style={warn}>
                  [TO CONFIRM: retention period for chat logs]
                </p>
                <p className="mono mt-2 max-w-none text-xs text-faint">
                  stays in the draft until you settle it
                </p>
              </div>
            </div>
          </div>
        </section>

        <section>
          <div className="text-center">
            <span className="sys-label sys-label--center">Deliverables</span>
            <h2 className="mt-6">What you can create</h2>
          </div>
          <div className="mt-12 grid gap-6 sm:grid-cols-2">
            <div className="panel rise">
              <h3>An AI acceptable use policy</h3>
              <p className="mt-4 text-sm">
                One document, sometimes called an AI usage policy, written for
                your staff to actually read: what your people may use AI for,
                what they may not, and who decides. Most companies should
                start here.
              </p>
            </div>
            <div className="panel rise" style={{ transitionDelay: "100ms" }}>
              <h3>A full governance set</h3>
              <p className="mt-4 text-sm">
                Seven to ten working-draft documents mapped to NIST AI RMF,
                the EU AI Act, or ISO/IEC 42001: risk registers, human
                oversight, transparency, scope and roles. Tron re-checks all
                three standards every quarter.
              </p>
            </div>
          </div>
          <div className="mt-6 grid gap-6 sm:grid-cols-1">
            <div className="panel rise">
              <h3>A bank AI policy suite, FFIEC aligned</h3>
              <p className="mt-4 text-sm">
                For banks and other federally supervised institutions: one
                Board-ready AI use policy plus targeted amendments to the
                policies your examiners already know, calibrated to your asset
                size from the Federal Reserve&apos;s bank list. Supervisory
                expectations move fast here, so Tron re-checks them every
                week.
              </p>
            </div>
          </div>
          <div className="mt-6 grid gap-6 sm:grid-cols-3">
            <div className="panel rise">
              <h3>In your house style</h3>
              <p className="mt-4 text-sm">
                Upload a Word or PDF sample of how your documents look, and
                drafts follow it. One button reformats the whole draft to
                match.
              </p>
            </div>
            <div className="panel rise" style={{ transitionDelay: "100ms" }}>
              <h3>Change your mind freely</h3>
              <p className="mt-4 text-sm">
                Change any earlier answer whenever you like, and reopen a
                finished draft when your rules change. The document keeps up.
              </p>
            </div>
            <div className="panel rise" style={{ transitionDelay: "200ms" }}>
              <h3>Yours in Word, anytime</h3>
              <p className="mt-4 text-sm">
                Download Word-friendly documents at every stage. Drafts carry
                a DRAFT watermark until you confirm the final.
              </p>
            </div>
          </div>
        </section>

        <section className="grid gap-12 text-center sm:grid-cols-3">
          <div className="stat rise">
            <div className="stat-value">$0</div>
            <div className="stat-label">The price, in full</div>
          </div>
          <div className="stat rise" style={{ transitionDelay: "120ms" }}>
            <div className="stat-value">
              7<em>-</em>10
            </div>
            <div className="stat-label">Documents in a full set</div>
          </div>
          <div className="stat rise" style={{ transitionDelay: "240ms" }}>
            <div className="stat-value">1</div>
            <div className="stat-label">Question at a time</div>
          </div>
        </section>

        <div className="text-center">
          <Link
            href="/login?redirect=/governance"
            className="btn btn--text no-underline"
          >
            Sign in and try it on your company{" "}
            <span aria-hidden="true">→</span>
          </Link>
        </div>

        <section className="mx-auto max-w-3xl">
          <div className="text-center">
            <span className="sys-label sys-label--center">
              Straight Answers
            </span>
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
        </section>

        <section className="mx-auto max-w-xl">
          <div className="panel panel--lightline text-center">
            <h3>Start with the research</h3>
            <p className="mx-auto mt-4 text-sm">
              Sign in with Google or Microsoft, name your company, and Tron
              researches it before asking you a single question. No card, no
              trial clock.
            </p>
            <Link
              href="/login?redirect=/governance"
              className="btn btn--primary mt-6 no-underline"
            >
              Sign in and start free
            </Link>
            <p className="mx-auto mt-4 text-xs" style={faint}>
              Not sure Tron is real? Open the chat in the corner and ask
              about this page.
            </p>
          </div>
          <p
            className="mono mx-auto mt-6 max-w-none text-center text-xs"
            style={faint}
          >
            <Link href="/work#governance">see it in the exhibit hall</Link> ·{" "}
            <Link href="/blog">read Tron&apos;s AI news desk</Link> ·{" "}
            <Link href="/methodology">news methodology</Link>
          </p>
          <p className="mx-auto mt-6 text-center text-xs" style={faint}>
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
