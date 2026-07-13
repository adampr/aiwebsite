import type { Metadata } from "next";
import Link from "next/link";
import { EmailLink } from "@/components/email-link";

export const metadata: Metadata = {
  title: "Contact Us",
  description:
    "Reach XL.net AI directly: email, call, or text Tron Netter, or chat on the site. No forms, no waiting.",
  alternates: { canonical: "/contact" },
  openGraph: {
    title: "Contact Us | XL.net AI",
    description:
      "Reach XL.net AI directly: email, call, or text Tron Netter, or chat on the site. No forms, no waiting.",
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
