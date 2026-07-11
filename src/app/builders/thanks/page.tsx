import type { Metadata } from "next";
import Link from "next/link";
import Stripe from "stripe";
import { OFFERINGS, isOfferingId } from "@/lib/stripe/offerings";

export const metadata: Metadata = {
  title: "Welcome, Builder",
  description: "Your AI Builder registration is confirmed.",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

async function lookupSession(sessionId: string | undefined) {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!sessionId || !secretKey) return null;
  try {
    const stripe = new Stripe(secretKey);
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.status !== "complete") return null;
    const offeringId = session.metadata?.offering;
    return {
      offeringName: isOfferingId(offeringId)
        ? OFFERINGS[offeringId].name
        : null,
      email: session.customer_details?.email ?? null,
    };
  } catch {
    return null;
  }
}

export default async function ThanksPage({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string }>;
}) {
  const { session_id } = await searchParams;
  const session = await lookupSession(session_id);

  return (
    <div className="mx-auto max-w-2xl space-y-16 text-center">
      <section className="pt-16">
        <span className="sys-label sys-label--sand sys-label--center">
          Registration Confirmed
        </span>
        <h1 className="mt-8">
          Welcome, <span className="glow">Builder</span>
        </h1>
        {session ? (
          <p className="mx-auto mt-6 text-lg">
            You&apos;re in{session.offeringName ? <> — <strong>{session.offeringName}</strong></> : null}.
            {session.email ? (
              <> A receipt is on its way to <span className="mono">{session.email}</span>, and</>
            ) : (
              <> A receipt is on its way, and</>
            )}{" "}
            we&apos;ll follow up personally with session details and everything
            you need to prepare.
          </p>
        ) : (
          <p className="mx-auto mt-6 text-lg">
            Thanks for registering. If your payment completed, a receipt is on
            its way and we&apos;ll follow up personally with session details.
            Didn&apos;t finish checkout? <Link href="/builders">Head back</Link>{" "}
            and try again.
          </p>
        )}
        <div className="mt-12 flex flex-wrap justify-center gap-6">
          <Link href="/work" className="btn btn--primary no-underline">
            Tour what we&apos;ve built
          </Link>
          <Link href="/contact" className="btn no-underline">
            Questions? Talk to us
          </Link>
        </div>
      </section>
    </div>
  );
}
