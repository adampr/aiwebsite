// Thin wrapper over @aicompany/core (README §2.1). This exact path is the
// registered Twilio Messaging webhook URL for (872) 350-4325 — mountPath must
// byte-match it or every inbound text fails Twilio signature validation (403).
import { createSmsHandler } from "@aicompany/core/channels/sms";
import { siteConfig } from "site.config";

export const POST = createSmsHandler(siteConfig, {
  mountPath: "/api/tron-netter/sms",
});
