import type { Metadata } from "next";
import Link from "next/link";
import { EmailLink } from "@/components/email-link";

export const metadata: Metadata = {
  title: "Contact Us: Email, Call, or Text Tron Netter",
  description:
    "Reach XL.net AI directly: email, call, or text Tron Netter, our AI agent, or chat on the site. Available 24/7 with no forms and no waiting for a reply.",
  alternates: { canonical: "/contact" },
  openGraph: {
    title: "Contact Us: Email, Call, or Text Tron Netter | XL.net AI",
    description:
      "Reach XL.net AI directly: email, call, or text Tron Netter, our AI agent, or chat on the site. Available 24/7 with no forms and no waiting for a reply.",
  },
};

export default function ContactPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-16">
      <section className="pt-8">
        <span className="sys-label">Home / Contact</span>
        <h1 className="mt-8">Contact Us</h1>
        <p className="mt-6 text-lg">
          XL.net is a leader in AI-powered managed IT services for small and
          mid-size businesses. There&apos;s no form to fill out here. Reach
          Tron Netter, our AI agent, directly by email, phone, text, or chat.
          Available 24/7.
        </p>
      </section>

      <div className="grid gap-6 sm:grid-cols-2">
        {/* Email panel */}
        <section className="panel rise">
          <span className="sys-label">Signal</span>
          <h3 className="mt-4">Email</h3>
          <p className="mt-3 text-sm">
            Email Tron Netter with questions, partnerships, or feedback
          </p>
          <EmailLink
            email="Tron.Netter@ai.xl.net"
            className="mono mt-4 inline-block text-sm"
          />
        </section>

        {/* Phone & Text panel */}
        <section
          className="panel panel--lightline rise"
          style={{ transitionDelay: "120ms" }}
        >
          <span className="sys-label">Voice / SMS</span>
          <h3 className="mt-4">Phone &amp; Text</h3>
          <p className="mt-3 text-sm">
            Call or text Tron Netter, our AI agent, 24/7
          </p>
          <div className="mt-4 flex items-center gap-4">
            <a href="tel:+18723504325" className="mono text-sm">
              (872) 350-4325
            </a>
            <a href="sms:+18723504325" className="mono text-sm">
              Send a text
            </a>
          </div>
          <p className="mt-3 text-xs opacity-70">
            Standard message &amp; data rates apply.{" "}
            <Link href="/texting">Register your number</Link> to text with
            Tron Netter from your account.
          </p>
        </section>
      </div>

      {/* What Tron handles now vs. what he routes to a human */}
      <section>
        <span className="sys-label">Expectations</span>
        <h2 className="mt-6">What Tron answers, and what he hands off</h2>
        <p className="mt-4 text-sm">
          Tron Netter is a real AI agent, not a chat widget that files a
          ticket. He answers immediately, on any channel, at any hour — and
          when a question needs a person, he says so rather than guessing.
        </p>
        <div className="mt-6 grid gap-6 sm:grid-cols-2">
          <div className="panel">
            <h3 className="text-base">Answered on the spot</h3>
            <ul className="mt-3 space-y-2 text-sm">
              <li>
                How our AI-powered managed IT services work, and what is
                actually automated versus human-supervised
              </li>
              <li>
                What the <Link href="/builders">AI Builders</Link> program
                covers and who each session is for
              </li>
              <li>
                How we approach <Link href="/governance">AI governance</Link> —
                data handling, model choice, and where humans stay in the loop
              </li>
              <li>
                Examples from our <Link href="/work">work</Link>, including
                what did not go to plan
              </li>
            </ul>
          </div>
          <div className="panel">
            <h3 className="text-base">Routed to a person</h3>
            <ul className="mt-3 space-y-2 text-sm">
              <li>
                Pricing for a specific environment, contracts, and anything
                requiring a signature
              </li>
              <li>
                Active incidents on a system we already manage — call or text,
                do not wait on chat
              </li>
              <li>
                Press and analyst enquiries, and partnership or vendor
                proposals
              </li>
              <li>
                Security disclosures, data-deletion requests, and anything
                touching a named individual&apos;s records
              </li>
            </ul>
          </div>
        </div>
        <p className="mt-6 text-sm">
          Looking for traditional managed IT rather than the AI practice? XL.net
          is the parent business and handles that directly at{" "}
          <a href="https://www.xl.net" rel="noopener">
            xl.net
          </a>
          . Interested in the roleplay training product instead? That is a
          separate team at{" "}
          <a href="https://roleplay.xl.net" rel="noopener">
            roleplay.xl.net
          </a>
          .
        </p>
        <p className="mt-4 text-sm opacity-80">
          However you reach us, the same agent answers. There is no queue, no
          form, and no callback window — email, phone, text and chat all reach
          Tron Netter directly, and every one of them is answered 24/7. If you
          would rather talk to a human from the outset, say exactly that and he
          will arrange it instead of trying to resolve it himself.
        </p>
      </section>

      {/* Chat with Tron Netter showcase */}
      <section className="panel--void beams relative text-center">
        <div className="relative z-10 mx-auto max-w-xl px-6">
          <span className="sys-label sys-label--sand sys-label--center">
            Live Channel
          </span>
          <h2 className="mt-6">Chat with Tron Netter</h2>
          <p className="mx-auto mt-4 text-sm">
            Have a question about our AI capabilities, managed IT services, or
            how we work? Chat with Tron Netter right now using the chat button
            in the bottom right corner of this page. He&apos;s the same AI
            agent on every channel: web, phone, and text. Helpful, accurate,
            and available 24/7.
          </p>
        </div>
      </section>
    </div>
  );
}
