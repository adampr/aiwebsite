// Thin wrapper over @aicompany/core (README §2.1): publish / unpublish /
// noindex / mark-reviewed / regenerate row actions for /admin/blog (§19.10).
import { createAdminBlogActionHandler } from "@aicompany/core/admin/api";
import { siteConfig } from "site.config";

export const POST = createAdminBlogActionHandler(siteConfig);
