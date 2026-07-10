// Thin wrapper over @aicompany/core (README §2.1).
import { createSessionHandler } from "@aicompany/core/auth/handlers";
import { siteConfig } from "site.config";

export const GET = createSessionHandler(siteConfig);
