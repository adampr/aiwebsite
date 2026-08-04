// Host-owned HARDENED callback (§5.18): same pipeline as the module handler
// plus the per-login mail-verified session claim (email_verified strict) the
// roadmap tenancy gate requires. This exact path is the registered Google
// OAuth redirect URI — do not move it. The start route stays module-owned.
import { createHardenedCallbackHandler } from "@/lib/auth/oauth-hardened";
import { siteConfig } from "site.config";

export const GET = createHardenedCallbackHandler(siteConfig, "google");
