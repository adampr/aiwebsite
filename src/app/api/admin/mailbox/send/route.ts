// Thin wrapper over @aicompany/core (README §2.1). Manual send from the
// persona mailbox (from oversight.mailFrom, oversight BCC enforced inside the
// module's sendEmail); recorded in admin_emails so threads show human turns.
import { createAdminMailboxSendHandler } from "@aicompany/core/admin/api";
import { siteConfig } from "site.config";

export const POST = createAdminMailboxSendHandler(siteConfig);
