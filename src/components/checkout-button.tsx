"use client";

import { useState } from "react";
import type { OfferingId } from "@/lib/stripe/offerings";

// Buy button for an AI Builder offering: POSTs to /api/checkout and follows
// the returned Stripe-hosted Checkout URL. Card entry never happens on-site.
export function CheckoutButton({
  offering,
  children,
  className = "btn btn--primary",
}: {
  offering: OfferingId;
  children: React.ReactNode;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [message, setMessage] = useState("");

  async function startCheckout() {
    setState("loading");
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offering }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) {
        setMessage(data.error || "Could not start checkout.");
        setState("error");
        return;
      }
      window.location.assign(data.url);
    } catch {
      setMessage("Could not reach the server. Please try again.");
      setState("error");
    }
  }

  return (
    <div>
      <button
        type="button"
        className={className}
        onClick={startCheckout}
        disabled={state === "loading"}
      >
        {state === "loading" ? "Opening secure checkout…" : children}
      </button>
      {state === "error" && (
        <p className="mt-3 text-xs" role="alert" style={{ color: "var(--xl-warn)" }}>
          {message}
        </p>
      )}
    </div>
  );
}
