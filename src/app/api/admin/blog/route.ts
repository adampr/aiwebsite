// Thin wrapper over @aicompany/core (README §2.1): admin blog list feed
// for /admin/blog (§19.10).
import { createAdminBlogListHandler } from "@aicompany/core/admin/api";
import { siteConfig } from "site.config";

export const GET = createAdminBlogListHandler(siteConfig);
