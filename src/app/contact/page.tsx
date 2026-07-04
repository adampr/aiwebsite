import type { Metadata } from "next";
import { ContactForm } from "@/components/contact-form";

export const metadata: Metadata = {
  title: "Contact Us",
  description:
    "Get in touch with XL.net AI — email, phone, or chat with Tron Netter.",
  alternates: { canonical: "/contact" },
  openGraph: {
    title: "Contact Us — XL.net AI",
    description: "Get in touch with XL.net AI — email, phone, or chat with Tron Netter.",
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
          mid-size businesses. Have questions about our AI capabilities or want
          to learn more? We&apos;d love to hear from you.
        </p>
      </section>

      <div className="grid gap-6 sm:grid-cols-2">
        {/* Email panel */}
        <section className="panel rise">
          <span className="sys-label">Signal</span>
          <h3 className="mt-4">Email</h3>
          <p className="mt-3 text-sm">Questions, partnerships, or feedback</p>
          <a
            href="mailto:ai@xl.net"
            className="mono mt-4 inline-block text-sm"
          >
            ai@xl.net
          </a>
        </section>

        {/* Phone panel */}
        <section
          className="panel panel--lightline rise"
          style={{ transitionDelay: "120ms" }}
        >
          <span className="sys-label">Voice</span>
          <h3 className="mt-4">Phone</h3>
          <p className="mt-3 text-sm">
            Talk to Tron Netter, our AI assistant — 24/7
          </p>
          <a
            href="tel:+18723504325"
            className="mono mt-4 inline-block text-sm"
          >
            (872) 350-4325
          </a>
        </section>
      </div>

      {/* Contact form */}
      <section className="panel panel--raised rise">
        <span className="sys-label">Transmission</span>
        <h2 className="mt-4">Send Us a Message</h2>
        <div className="mt-8">
          <ContactForm />
        </div>
      </section>

      {/* Tron Netter callout */}
      <section className="panel--void beams relative text-center">
        <div className="relative z-10 mx-auto max-w-xl px-6">
          <span className="sys-label sys-label--sand sys-label--center">
            Live Channel
          </span>
          <h2 className="mt-6">Chat with Tron Netter</h2>
          <p className="mx-auto mt-4 text-sm">
            Have a quick question? Chat with Tron Netter, our AI assistant,
            using the chat button in the bottom right corner — or call and it
            will answer. Available 24/7.
          </p>
        </div>
      </section>
    </div>
  );
}
