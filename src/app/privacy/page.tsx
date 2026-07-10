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
  return <PrivacyPolicyPage config={siteConfig} lastUpdated="July 2026" />;
}
