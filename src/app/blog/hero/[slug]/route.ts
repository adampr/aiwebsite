import { createBlogHeroHandler } from "@aicompany/core/blog/hero-route";

import { siteConfig } from "site.config";

// Serves the §19.26 default hero storage (blog_hero_images) — needed since
// blog.heroImage uses createGeminiHeroGenerator's default DB storage; this
// path must match the adapter's routePath (doctor probes it, §19.11).
export const GET = createBlogHeroHandler(siteConfig);
