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
    // §5.18: the roadmap portal shipped without an entry here, leaving every
    // roadmap mutation (directory add/edit/remove, doc upload and delete,
    // Apollo import, company bootstrap, admin request and approval, DKIM
    // recheck and instruction mail) with no same-origin check. SameSite=lax
    // session cookies blunt the classic cross-site form POST, so this is
    // defense in depth rather than a live exploit, but it is the most
    // PII-bearing subsystem on the site and the list is hand-maintained.
    // The module checks POST/PUT/PATCH/DELETE only, so the roadmap GETs
    // (dkim/status, docs/[id], nav) are untouched.
    "/api/roadmap",
    // §5.10: workshop notification list join/leave (POST/DELETE
    // /api/workshop/notify) — state-changing, session-scoped writes.
    "/api/workshop",
    // NOTHING XLANT REMAINS HERE (§5.22 decommission record). The prefix
    // "/api/internal/xlant" left this list on 2026-09-18 when the XLAnt
    // identity lane (device-token mint, computer list, sign-out) was deleted
    // from this host — the desktop enrols via an approved code on
    // https://xlant.ai/connect now, so there is no route under it to protect.
    // "/api/xlant" (the DEVICE lane, decommissioned 2026-09-15) stays out
    // too, and neither should ever be re-added on sight: the device callers
    // were the XLAnt desktop and an MCP client, neither a browser and neither
    // sending an Origin, so a CSRF check would have refused every one of
    // their POSTs. Also NOT the whole of /api/internal: all three surviving
    // trees — /api/internal/track, /api/internal/issues and
    // /api/internal/seo-rubric — are secret-authenticated machine POSTs from
    // the proxy itself, the VM watchdog and the dev box, none of which carry
    // a browser Origin.
  ],
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
