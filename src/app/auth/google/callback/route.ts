// Thin wrapper over @aicompany/core (README §2.1). This exact path is the
// registered Google OAuth redirect URI — do not move it.
import { createOAuthCallbackHandler } from "@aicompany/core/auth/oauth-google";
import { siteConfig } from "site.config";

export const GET = createOAuthCallbackHandler(siteConfig);
