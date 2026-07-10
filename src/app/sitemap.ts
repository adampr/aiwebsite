// Thin wrapper over @aicompany/core (README §2.1): the module maps these
// site-relative paths onto site.baseUrl; the host owns the entry list's
// completeness.
import { createSitemap } from "@aicompany/core/seo/sitemap";
import { siteConfig } from "site.config";

export default createSitemap(siteConfig, [
  { path: "/" },
  { path: "/contact" },
  { path: "/privacy" },
  { path: "/sms-terms" },
  { path: "/texting" },
]);
