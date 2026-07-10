// Thin wrapper over @aicompany/core (README §2.1): telemetry + preference
// sink for the SMS prompt card (UI preference surface, not consent — hence
// /api/auth/*, not /api/texting/*).
import { createSmsPromptEventHandler } from "@aicompany/core/channels/texting";
import { siteConfig } from "site.config";

export const POST = createSmsPromptEventHandler(siteConfig);
