import Link from "next/link";
import { TextingWizard } from "@aicompany/core/components/texting-wizard";
import { toTextingWizardProps } from "@aicompany/core/components/props";
import { siteConfig } from "site.config";

// Page shell (heading + footnote) kept from the legacy page; the wizard
// itself — session check → phone + consent → code entry → verified — is the
// module's <TextingWizard/>. Metadata lives in texting/layout.tsx.
export default function TextingPage() {
  return (
    <div className="mx-auto max-w-lg space-y-8 pt-12">
      <div className="text-center">
        <span className="sys-label sys-label--center">SMS Channel</span>
        <h1 className="mt-4 text-3xl font-bold">Text with Tron Netter</h1>
        <p className="mx-auto mt-3 text-sm">
          Register your mobile number to text with Tron Netter, our AI agent.
          We&apos;ll verify the number with a one-time code before it&apos;s
          added to your account.
        </p>
      </div>

      <TextingWizard {...toTextingWizardProps(siteConfig)} />

      <p className="text-center text-xs" style={{ color: "var(--xl-text-faint)" }}>
        Opting in is optional and not required to use this site. Full details in
        the <Link href="/sms-terms">SMS Terms &amp; Conditions</Link> and{" "}
        <Link href="/privacy">Privacy Policy</Link>.
      </p>
    </div>
  );
}
