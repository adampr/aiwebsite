// Thin wrapper over @aicompany/core (README §2.1). Admin SMS console over the
// Twilio REST API; the shared Twilio account means every query stays scoped to
// the persona's number (never account-wide). Admin-initiated sends are consent-
// gated against sms_consent_logs (module §5.6/§5.2).
import { createAdminMessagesHandler } from "@aicompany/core/admin/api";
import { siteConfig } from "site.config";

export const { GET, POST } = createAdminMessagesHandler(siteConfig);
