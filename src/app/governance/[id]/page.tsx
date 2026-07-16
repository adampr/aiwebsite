import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { readSession } from "@aicompany/core/auth/session";
import { siteConfig } from "site.config";
import { Workspace } from "@/components/governance/workspace";

// Server shell only: session gate (deep-link redirect back after login),
// then the client workspace takes over. The 404-like "project is gone"
// state renders client-side from the API's oracle-free 404.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Governance workspace",
  robots: { index: false, follow: false },
};

export default async function GovernanceProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await readSession(siteConfig);
  if (!session) {
    redirect(`/login?redirect=${encodeURIComponent(`/governance/${id}`)}`);
  }
  return <Workspace projectId={id} />;
}
