// Thin wrapper over @aicompany/core (README §2.1). Polled by the external
// uptime monitor and post-deploy checks.
import { createHealthHandler } from "@aicompany/core/auth/handlers";
import { siteConfig } from "site.config";

export const GET = createHealthHandler(siteConfig);
