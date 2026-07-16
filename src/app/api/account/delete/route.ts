// POST /api/account/delete — §5.13 module factory (@aicompany/core v1.6).
// governance_projects cascade with the users row (schema onDelete:
// "cascade"); contact_submissions are personal data keyed by email with no
// FK — removed in beforeDelete. governance_usage/governance_meta are global
// (no per-user rows) and untouched.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { eq } from "drizzle-orm";
import { createAccountDeletionHandler } from "@aicompany/core/account/data";
import { siteConfig } from "site.config";
import { db } from "@/lib/db";
import { contactSubmissions } from "@/lib/db/schema";

export const POST = createAccountDeletionHandler(siteConfig, {
  beforeDelete: async (user) => {
    await db.delete(contactSubmissions).where(eq(contactSubmissions.email, user.email));
  },
});
