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
    <div className="mx-auto max-w-3xl space-y-8">
      <nav aria-label="Breadcrumb" className="text-sm text-neutral-500 dark:text-neutral-400">
        <a href="/" className="hover:text-[#010205] dark:hover:text-white">Home</a>
        <span className="mx-2">/</span>
        <span>Contact</span>
      </nav>

      <h1 className="text-3xl font-bold">Contact Us</h1>

      <section className="space-y-3">
        <p className="text-lg">
          XL.net is a leader in AI-powered managed IT services for small and
          mid-size businesses. Have questions about our AI capabilities or want
          to learn more? We&apos;d love to hear from you.
        </p>
      </section>

      <div className="grid gap-6 sm:grid-cols-2">
        {/* Email card */}
        <section className="card p-6">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-[var(--xl-primary)]/10">
            <svg
              viewBox="0 0 24 24"
              className="h-5 w-5 text-[var(--xl-primary)] dark:text-[#7b7bff]"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect width="20" height="16" x="2" y="4" rx="2" />
              <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold">Email</h2>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            Questions, partnerships, or feedback
          </p>
          <a
            href="mailto:ai@xl.net"
            className="link-accent mt-2 inline-block text-sm font-medium"
          >
            ai@xl.net
          </a>
        </section>

        {/* Phone card */}
        <section className="card p-6">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-[var(--xl-primary)]/10">
            <svg
              viewBox="0 0 24 24"
              className="h-5 w-5 text-[var(--xl-primary)] dark:text-[#7b7bff]"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold">Phone</h2>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            Talk to Tron Netter, our AI assistant
          </p>
          <div className="mt-2 flex items-center gap-3">
            <a
              href="tel:+18723504325"
              className="link-accent text-sm font-medium"
            >
              (872) 350-4325
            </a>
          </div>
        </section>
      </div>

      {/* Contact form */}
      <section className="card p-6">
        <h2 className="mb-4 text-lg font-semibold">Send Us a Message</h2>
        <ContactForm />
      </section>

      {/* Tron Netter callout */}
      <section className="rounded-lg border border-[var(--xl-primary)]/30 bg-[var(--xl-primary)]/5 p-6 dark:border-[#7b7bff]/30 dark:bg-[var(--xl-primary)]/10">
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--xl-primary)] text-white">
            <svg
              viewBox="0 0 24 24"
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-semibold">Chat with Tron Netter</h2>
            <p className="mt-1 text-sm text-neutral-700 dark:text-neutral-300">
              Have a quick question? Chat with Tron Netter, our AI assistant,
              using the chat button in the bottom right corner. Tron Netter can
              tell you about XL.net&apos;s AI capabilities and help you find the
              information you need — available 24/7.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
