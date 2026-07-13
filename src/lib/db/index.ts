// Db wrapper: registers the composed tables with the @aicompany/core client
// so module code (auth, admin, channels, texting) reads/writes the HOST's
// actual table objects, and re-exports the module's lazy drizzle proxy under
// the historical `db` name for the rest of the site. instrumentation.ts
// imports this file before runtimeCheck (packages/aicompany §4.3).
import { db, getDb, registerTables } from "@aicompany/core/db/client";
import * as schema from "./schema";

// magicLinks is deliberately omitted — auth.providers.magicLink is off.
registerTables({
  users: schema.users,
  authLogs: schema.authLogs,
  pageVisits: schema.pageVisits,
  ipOrgs: schema.ipOrgs,
  adminEmails: schema.adminEmails,
  smsConsentLogs: schema.smsConsentLogs,
  phoneVerifications: schema.phoneVerifications,
  smsPromptEvents: schema.smsPromptEvents,
  smsNotices: schema.smsNotices,
  smsMemoryNotices: schema.smsMemoryNotices,
  memoryDeletionLogs: schema.memoryDeletionLogs,
  blogPosts: schema.blogPosts,
  blogHeroImages: schema.blogHeroImages,
});

export { db, getDb, schema };
