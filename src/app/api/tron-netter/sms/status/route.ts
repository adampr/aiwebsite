// Twilio delivery-status callback (module §5.12): sendSms() points every
// outbound message's StatusCallback here so carrier filtering (error 30034)
// and undelivered messages alert oversight instead of looking like success.
// mountPath must byte-match this route's path for signature validation.
import { createSmsStatusHandler } from "@aicompany/core/channels/sms";
import { siteConfig } from "site.config";

export const POST = createSmsStatusHandler(siteConfig, {
  mountPath: "/api/tron-netter/sms/status",
});
