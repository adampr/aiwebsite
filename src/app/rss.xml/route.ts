// Thin wrapper over @aicompany/core (README §2.1). Must live at
// blog.rss.path (default "/rss.xml") — `npm run doctor` probes it (§19.11).
// Every item carries the AI-authorship disclosure + canonical URL (§19).
import { createBlogRssHandler } from "@aicompany/core/blog/rss";
import { siteConfig } from "site.config";

export const GET = createBlogRssHandler(siteConfig);
