// Thin wrapper over @aicompany/core (README §2.1).
import { createLogoutHandler } from "@aicompany/core/auth/handlers";
import { siteConfig } from "site.config";

export const POST = createLogoutHandler(siteConfig);
