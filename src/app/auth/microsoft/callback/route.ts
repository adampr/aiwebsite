// Host-owned HARDENED callback (§5.18): same pipeline as the module handler
// plus the id_token xms_edov validation (the real nOAuth fix) carried as a
// per-login mail-verified session claim. This exact path is the registered
// Microsoft Entra OAuth redirect URI — do not move it. The start route stays
// module-owned.
import { createHardenedCallbackHandler } from "@/lib/auth/oauth-hardened";
import { siteConfig } from "site.config";

export const GET = createHardenedCallbackHandler(siteConfig, "microsoft");
