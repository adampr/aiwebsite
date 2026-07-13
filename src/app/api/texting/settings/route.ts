// Thin wrapper over @aicompany/core (README §2.1): the <AccountSettings/>
// data source on /account — the session's linked number, verification/opt-in
// state, and latest consent-log posture. Session-gated, never cached.
import { createTextingSettingsHandler } from "@aicompany/core/channels/texting";
import { siteConfig } from "site.config";

export const GET = createTextingSettingsHandler(siteConfig);
