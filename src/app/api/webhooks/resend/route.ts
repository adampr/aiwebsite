// Resend inbound webhook — the module handler (§5.3), one verification, one
// pipeline. Troy.Netter budget-approval routing (§5.12) lives in
// channels.email.onInbound (site.config.ts) since @aicompany/core v1.6; the
// host tee that cloned the request and re-verified svix here is retired.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { createInboundEmailHandler } from "@aicompany/core/channels/email";
import { siteConfig } from "site.config";

export const POST = createInboundEmailHandler(siteConfig);
