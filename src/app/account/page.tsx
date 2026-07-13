import { AccountSettings } from "@aicompany/core/components/account-settings";
import { toAccountSettingsProps } from "@aicompany/core/components/props";
import { siteConfig } from "site.config";

// Page shell (heading) mirrors /texting; the settings panel itself — texting
// status → remove number → prompt-card preference — is the module's
// <AccountSettings/>. Must live at texting.settingsPath ("/account"): the
// SMS prompt card's dismiss note links here and the card is suppressed on
// this route (module §5.10). Metadata lives in account/layout.tsx.
export default function AccountPage() {
  return (
    <div className="mx-auto max-w-lg space-y-8 pt-12">
      <div className="text-center">
        <span className="sys-label sys-label--center">Account</span>
        <h1 className="mt-4 text-3xl font-bold">Account Settings</h1>
        <p className="mx-auto mt-3 text-sm">
          Manage how you text with Tron Netter, our AI agent — your verified
          number, message opt-in, and the texting prompt.
        </p>
      </div>

      <AccountSettings {...toAccountSettingsProps(siteConfig)} />
    </div>
  );
}
