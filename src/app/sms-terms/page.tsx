import type { Metadata } from "next";
import { SmsTermsPage as SmsTermsContent } from "@aicompany/core/legal/sms-terms-page";
import { siteConfig } from "site.config";

export const metadata: Metadata = {
  title: "SMS Terms & Conditions",
  description:
    "Terms and conditions for XL.net AI's text messaging program with Tron Netter.",
  alternates: { canonical: "/sms-terms" },
};

export default function SmsTermsPage() {
  return <SmsTermsContent config={siteConfig} lastUpdated="July 2026" />;
}
