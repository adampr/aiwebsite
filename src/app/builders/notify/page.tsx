import type { Metadata } from "next";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { readSession } from "@aicompany/core/auth/session";
import { siteConfig } from "site.config";
import { db } from "@/lib/db";
import { workshopInterest } from "@/lib/db/schema";
import { NotifyButtons } from "./notify-buttons";

export const metadata: Metadata = {
  title: "Workshop Notification List",
  description:
    "Get an email when the next AI Builders Workshop date is set.",
  robots: { index: false, follow: false },
};

// Session-keyed page (membership renders server-side per visitor).
export const dynamic = "force-dynamic";

// The AI Builders Workshop notification list (§5.10). Signed-out visitors
// get the explanation plus a sign-in link that returns here (/login carries
// ?redirect through the OAuth start routes' redirect cookie). Signed-in
// visitors see their address and the explicit opt-in / remove control —
// consent is always a deliberate click, never a side effect of signing in.
export default async function WorkshopNotifyPage() {
  const session = await readSession(siteConfig);
  const email = session?.email.trim().toLowerCase() ?? null;
  const joined = email
    ? (
        await db
          .select({ id: workshopInterest.id })
          .from(workshopInterest)
          .where(eq(workshopInterest.email, email))
          .limit(1)
      ).length > 0
    : false;

  return (
    <div className="mx-auto max-w-md space-y-8 pt-12">
      <div className="text-center">
        <span className="sys-label">AI Builders</span>
        <h1 className="mt-2 text-3xl font-bold">Next Workshop</h1>
        <p className="mt-2 text-sm">
          The August 27 workshop sold out. Join the notification list and
          we&apos;ll email you when the next session date is set.
        </p>
      </div>

      <div className="panel panel--raised space-y-4">
        {session ? (
          <>
            <p className="text-sm">
              You are signed in as <strong>{session.email}</strong>. The
              notification list uses this address.
            </p>
            <NotifyButtons initialJoined={joined} />
          </>
        ) : (
          <>
            <p className="text-sm">
              Sign in first so we know which address to notify; then one
              click adds you to the list. We only use your name and email
              address, and you can remove yourself anytime.
            </p>
            <Link
              href="/login?redirect=/builders/notify"
              className="btn btn--primary w-full no-underline"
            >
              Sign in to continue
            </Link>
          </>
        )}
      </div>

      <p className="text-center text-xs" style={{ color: "var(--xl-text-faint)" }}>
        One list, one purpose: announcing the next AI Builders Workshop.{" "}
        <Link href="/builders">Back to AI Builders</Link>
      </p>
    </div>
  );
}
