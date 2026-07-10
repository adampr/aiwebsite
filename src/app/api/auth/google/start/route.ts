// Thin wrapper over @aicompany/core (README §2.1). Starts live under
// /api/auth/…; callbacks under /auth/… (registered Google redirect URIs).
import { createOAuthStartHandler } from "@aicompany/core/auth/oauth-google";
import { siteConfig } from "site.config";

export const GET = createOAuthStartHandler(siteConfig);
