// Thin wrapper over @aicompany/core (README §2.1): step 1 of the verified
// SMS opt-in — texts a 6-digit code; nothing persists until /verify.
import { createTextingStartHandler } from "@aicompany/core/channels/texting";
import { siteConfig } from "site.config";

export const POST = createTextingStartHandler(siteConfig);
