// Thin wrapper over @aicompany/core (README §2.1): module admin chrome + nav
// built from admin.enabledPages. Defense-in-depth kept from the legacy layout:
// the module AdminLayout redirects non-admins itself (and every module admin
// page guards itself too), but this shell re-checks the session so the
// layout-level redirect survives any module regression.
import { redirect } from "next/navigation";
import { AdminLayout, adminMetadata } from "@aicompany/core/admin/layout";
import { readSession } from "@aicompany/core/auth/session";
import { isAdmin } from "@aicompany/core/auth/guard";
import { siteConfig } from "site.config";

export const metadata = adminMetadata;

export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await readSession(siteConfig);
  if (!session || !isAdmin(session.email)) redirect("/login");

  return <AdminLayout config={siteConfig}>{children}</AdminLayout>;
}
