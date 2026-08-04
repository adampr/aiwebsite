import type { Metadata } from "next";
import { PrivacyPolicyPage } from "@aicompany/core/legal/privacy-page";
import { siteConfig } from "site.config";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How XL.net AI collects, uses, and protects your data across the site, chat, SMS, email, and voice channels, plus retention rules for AI governance projects.",
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
          answers, the drafts, a research brief we compile from your
          company&apos;s public web presence, and, if you upload one, the text
          we extract from your format sample (the uploaded file itself is not
          kept). Your answers, our research, the working drafts, and that
          extracted text are processed by third-party AI model providers to
          draft the documents;
          nothing from a governance project is stored in Tron Netter&apos;s
          long-term memory or shared with other visitors.
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
      {/* Host-owned addendum (§5.18): AI Roadmap company workspaces. Keep in
          lockstep with the roadmap access rules (src/lib/roadmap/access.ts)
          and the scorecard/directory disclosures rendered in the portal. */}
      <section className="mx-auto mt-12 max-w-3xl">
        <h2>AI Roadmap company workspaces</h2>
        <p className="mt-4">
          The AI Roadmap at /roadmap groups signed-in users by the domain of
          their verified work email address. The first verified person from a
          company to set up its workspace becomes that company&apos;s
          administrator; others can request administrator access, and we keep
          a record of those requests and their outcomes. For each workspace we
          store its roadmap progress, attached governance documents, a company
          directory (name, work email, and phone number for each listed
          person), work submissions and their published cards, and a scorecard
          that counts published submissions per person in the directory.
        </p>
        <p className="mt-4">
          Workspace content is visible to signed-in users on the same email
          domain and to XL.net administrators, who can view and manage every
          workspace in order to operate and support the service. It is never
          public, and we exclude it from search engines. Directory entries can
          be imported from Apollo, a third-party business directory, or added
          by your administrator; each entry is labeled with its source, we
          never contact the people listed, and an administrator can remove an
          entry at any time. When an Apollo-sourced entry is removed we keep a
          one-way fingerprint of the email address so future imports do not
          restore it. To have yourself removed from a company directory,
          contact your company&apos;s administrator or Tron.Netter@ai.xl.net.
        </p>
        <p className="mt-4">
          Work submissions from company workspaces are reviewed by the same
          third-party AI editorial process as our own published work. A
          governance document attached to a workspace is a copy that belongs
          to the company and is kept until an administrator removes it; the
          Governance Builder project it came from still deletes on its own
          30-day schedule. Workspace data is kept while the workspace is
          active; deleting a workspace removes all of it, and encrypted
          database backup copies expire within a further 30 days.
        </p>
      </section>
    </>
  );
}
