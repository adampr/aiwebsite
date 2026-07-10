// Thin wrapper over @aicompany/core (README §2.1): step 2 of the verified
// SMS opt-in — a correct code sets users.phone and appends the TCPA
// proof-of-consent row (sms_consent_logs).
import { createTextingVerifyHandler } from "@aicompany/core/channels/texting";
import { siteConfig } from "site.config";

export const POST = createTextingVerifyHandler(siteConfig);
