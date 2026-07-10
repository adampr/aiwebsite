// Thin wrapper over @aicompany/core (README §2.1). This exact path is the
// registered Resend inbound-email webhook URL for Tron.Netter@ai.xl.net.
// Shared-account sibling filtering (itsupportchicago) lives in
// site.config.ts channels.email.siblingSites.
import { createInboundEmailHandler } from "@aicompany/core/channels/email";
import { siteConfig } from "site.config";

export const POST = createInboundEmailHandler(siteConfig);
