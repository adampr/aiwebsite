// Thin wrapper over @aicompany/core (README §2.1). Starts live under
// /api/auth/…; callbacks under /auth/… (registered Entra redirect URIs).
import { createOAuthStartHandler } from "@aicompany/core/auth/oauth-microsoft";
import { siteConfig } from "site.config";

export const GET = createOAuthStartHandler(siteConfig);
