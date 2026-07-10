// Thin wrapper over @aicompany/core (README §2.1): CSRF origin checks for
// state-changing module routes plus fire-and-forget page-view tracking into
// /api/internal/track (fail-closed without INTERNAL_TRACK_SECRET and
// privacy.policyUrl). The module's default protected prefixes are a superset
// of the legacy /api/admin-only check (panel-mandated hardening); the
// registered Twilio/Resend webhook paths are not under any protected prefix,
// so no exemptions are needed.
import { createTrackingMiddleware } from "@aicompany/core/tracking/middleware";
import { siteConfig } from "site.config";

export default createTrackingMiddleware(siteConfig);

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
