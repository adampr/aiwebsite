// Thin wrapper over @aicompany/core (README §2.1). Spawns the nightly blog
// job (scripts/blog-nightly.ts) with a fixed argv allowlist — request strings
// never reach spawn (§19.10). node child_process, hence the explicit runtime.
import { createAdminBlogRunNowHandler } from "@aicompany/core/admin/api";
import { siteConfig } from "site.config";

export const runtime = "nodejs";

export const POST = createAdminBlogRunNowHandler(siteConfig);
