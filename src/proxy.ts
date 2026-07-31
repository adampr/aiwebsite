// Next 16 proxy convention (the renamed middleware file; proxy always runs in
// the Node.js runtime — https://nextjs.org/docs/messages/middleware-to-proxy).
// Running on Node also keeps site.config.ts (which this file imports) out of
// any Edge bundle, so its dynamic import of the governance approval handler
// (node:crypto/dns/fs/...) no longer trips Edge Runtime build warnings.
//
// Thin wrapper over @aicompany/core (README §2.1): CSRF origin checks for
// state-changing module routes plus fire-and-forget page-view tracking into
// /api/internal/track (fail-closed without INTERNAL_TRACK_SECRET and
// privacy.policyUrl). The module's default protected prefixes are a superset
// of the legacy /api/admin-only check (panel-mandated hardening); the
// registered Twilio/Resend webhook paths are not under any protected prefix,
// so no exemptions are needed.
import { createTrackingMiddleware } from "@aicompany/core/tracking/middleware";
import { siteConfig } from "site.config";

// Host routes /api/checkout (Stripe Checkout Session creation, §5.10) and
// /api/governance/* (AI Governance builder, §5.12) are state-changing, so
// they join the module's default CSRF-checked prefixes.
export default createTrackingMiddleware(siteConfig, {
  protectedPrefixes: [
    "/api/admin",
    "/api/auth/logout",
    "/api/auth/email",
    "/api/texting",
    "/api/auth/sms-prompt",
    "/api/checkout",
    "/api/governance",
    "/api/work",
    // §5.17: RFP handlers mutate drafts and knowledge; without this they
    // would ship with no same-origin check.
    "/api/rfp",
  ],
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
