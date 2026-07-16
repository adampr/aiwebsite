import type { Metadata } from "next";
import { PrivacyPolicyPage } from "@aicompany/core/legal/privacy-page";
import { siteConfig } from "site.config";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How XL.net AI collects, uses, and protects your data across the site, chat, SMS, email, and voice channels.",
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
  return (
    <>
      <PrivacyPolicyPage config={siteConfig} lastUpdated="July 2026" />
      {/* Host-owned addendum (§5.12): the module policy body cannot be
          edited, so the AI Governance disclosures render below it. Keep this
          in lockstep with the governance retention sweep and copy constants
          (src/lib/governance/config.ts). */}
      <section className="mx-auto mt-12 max-w-3xl">
        <h2>AI Governance projects</h2>
        <p className="mt-4">
          Signed-in users can draft AI governance documents with Tron Netter
          at /governance. For those projects we store your questionnaire
          answers, the drafts, and a research brief we compile from your
          company&apos;s public web presence. Your answers and our research
          are processed by third-party AI model providers to draft the
          documents; nothing from a governance project is stored in Tron
          Netter&apos;s long-term memory or shared with other visitors.
        </p>
        <p className="mt-4">
          Governance projects are deleted from our systems 30 days after your
          last activity on them (creating, answering, revising, confirming,
          or downloading counts as activity), and encrypted database backup
          copies expire within a further 30 days. You can also delete a
          project immediately from its project card. Downloaded documents are
          yours and are never stored on our servers.
        </p>
      </section>
    </>
  );
}
