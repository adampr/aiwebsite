// Thin wrapper over @aicompany/core (README §2.1): archive / restore a
// sign-in account from the /admin/contacts directory (§5.6).
import { createAdminContactsActionHandler } from "@aicompany/core/admin/api";
import { siteConfig } from "site.config";

export const POST = createAdminContactsActionHandler(siteConfig);
