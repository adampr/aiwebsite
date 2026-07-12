// Thin wrapper over @aicompany/core (README §2.1): the module maps these
// site-relative paths onto site.baseUrl; the host owns the entry list's
// completeness. blogSitemapEntries excludes noindexed rows, everything under
// blog.indexing="noindex", and the /blog index URL while 0 published (§19.7).
import { blogSitemapEntries } from "@aicompany/core/blog/sitemap";
import { createSitemap } from "@aicompany/core/seo/sitemap";
import { siteConfig } from "site.config";

const staticEntries = createSitemap(siteConfig, [
  { path: "/" },
  { path: "/work" },
  { path: "/builders" },
  { path: "/contact" },
  { path: "/privacy" },
  { path: "/sms-terms" },
  { path: "/texting" },
]);

export default async function sitemap() {
  return [...staticEntries(), ...(await blogSitemapEntries(siteConfig))];
}
