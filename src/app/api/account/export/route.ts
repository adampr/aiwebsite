// GET /api/account/export — §5.13 module factory (@aicompany/core v1.6) +
// host extras: governance projects (documents/transcript/research ride the
// row as JSON) and contact submissions (keyed by email, no FK).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { eq } from "drizzle-orm";
import { createAccountExportHandler } from "@aicompany/core/account/data";
import { siteConfig } from "site.config";
import { db } from "@/lib/db";
import { contactSubmissions, governanceProjects } from "@/lib/db/schema";

export const GET = createAccountExportHandler(siteConfig, {
  extras: async (user) => ({
    governanceProjects: await db
      .select()
      .from(governanceProjects)
      .where(eq(governanceProjects.userId, user.id)),
    contactSubmissions: await db
      .select()
      .from(contactSubmissions)
      .where(eq(contactSubmissions.email, user.email)),
  }),
});
