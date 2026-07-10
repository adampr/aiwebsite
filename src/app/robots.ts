// Thin wrapper over @aicompany/core (README §2.1): disallows the module's
// never-indexed surfaces (/admin, /api, /auth, /login) plus
// seo.extraRobotsDisallow, and points crawlers at /sitemap.xml.
import { createRobots } from "@aicompany/core/seo/robots";
import { siteConfig } from "site.config";

export default createRobots(siteConfig);
