import type { Metadata } from "next";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { readSession } from "@aicompany/core/auth/session";
import { siteConfig } from "site.config";
import { db } from "@/lib/db";
import { workshopInterest } from "@/lib/db/schema";
import { NotifyButtons } from "./notify-buttons";
import { WORKSHOP_SESSION_LABEL, workshopWindow } from "@/lib/workshop/session";

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
// The intro is window-aware (src/lib/workshop/session.ts): while the next
// session is bookable the list is for the date AFTER it; once that session
// has started it is the "next date" list again.
export default async function WorkshopNotifyPage() {
  const session = await readSession(siteConfig);
  // eslint-disable-next-line react-hooks/purity -- force-dynamic server page; per-request clock read is the point
  const booking = workshopWindow(Date.now()) !== "tba";
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
        {booking ? (
          <p className="mt-2 text-sm">
            The next open workshop is {WORKSHOP_SESSION_LABEL}:{" "}
            <Link href="/builders#workshop">reserve a seat</Link>{" "}
            while they last. Join the notification list and we&apos;ll email
            you when the date after it is set.
          </p>
        ) : (
          <p className="mt-2 text-sm">
            The {WORKSHOP_SESSION_LABEL}{" "}
            workshop has started. Join the notification list and we&apos;ll
            email you when the next session date is set.
          </p>
        )}
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
