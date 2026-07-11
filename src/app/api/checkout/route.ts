// Host-owned route (§5.10): creates a Stripe Checkout Session for one of the
// two AI Builder offerings and returns its redirect URL. Card entry happens
// entirely on Stripe-hosted Checkout — no payment data touches this server.
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { OFFERINGS, isOfferingId } from "@/lib/stripe/offerings";

export async function POST(req: NextRequest) {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    return NextResponse.json(
      { error: "Payments are not configured yet. Please contact us instead." },
      { status: 503 }
    );
  }

  let offeringId: unknown;
  try {
    ({ offering: offeringId } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isOfferingId(offeringId)) {
    return NextResponse.json({ error: "Unknown offering" }, { status: 400 });
  }
  const offering = OFFERINGS[offeringId];

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://ai.xl.net";
  const stripe = new Stripe(secretKey);

  const priceOverride = process.env[offering.priceEnv];
  const lineItem: Stripe.Checkout.SessionCreateParams.LineItem = priceOverride
    ? { price: priceOverride, quantity: 1 }
    : {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: offering.amount,
          product_data: {
            name: offering.name,
            description: offering.description,
          },
          ...(offering.mode === "subscription"
            ? { recurring: { interval: "month" as const } }
            : {}),
        },
      };

  try {
    const session = await stripe.checkout.sessions.create({
      mode: offering.mode,
      line_items: [lineItem],
      success_url: `${baseUrl}/builders/thanks?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/builders?canceled=1`,
      // Receipt + roster: Checkout collects the email; Stripe emails receipts
      // per dashboard settings, and the session lists who bought what.
      metadata: { offering: offering.id },
      ...(offering.mode === "payment"
        ? { customer_creation: "always" as const }
        : {}),
    });
    if (!session.url) {
      return NextResponse.json(
        { error: "Stripe did not return a redirect URL" },
        { status: 502 }
      );
    }
    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("[checkout] Stripe session create failed:", err);
    return NextResponse.json(
      { error: "Could not start checkout. Please try again or contact us." },
      { status: 502 }
    );
  }
}
