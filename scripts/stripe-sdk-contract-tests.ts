/**
 * Stripe SDK contract tests (ARCHITECTURE.md §5.10 checkout).
 *
 *   npm run test:stripesdk
 *
 * Pure, no network, no key: a local HTTP server stands in for api.stripe.com
 * (the SDK's documented host/port/protocol options). Pins what the two call
 * sites rely on:
 *   src/app/api/checkout/route.ts   new Stripe(key) ; checkout.sessions.create({...}) -> session.url
 *   src/app/builders/thanks/page.tsx checkout.sessions.retrieve(id) -> status, metadata.offering, customer_details.email
 * Neither site pins `apiVersion`, so every request carries the SDK's own pinned
 * version: this prints it and asserts the header equals Stripe.API_VERSION.
 * The create params below are the route's, built from the same OFFERINGS
 * entry, for both the inline price_data path and the STRIPE_PRICE_COHORT
 * override path. Added by the 2026-10-09 dependency-upgrade train
 * (stripe 22.3.1 -> 23.0.0: API version 2026-06-24.dahlia -> 2026-09-30.endive).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { isDeepStrictEqual } from "node:util";
import Stripe from "stripe";
import { OFFERINGS } from "../src/lib/stripe/offerings";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = isDeepStrictEqual(actual, expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `\n     got  ${JSON.stringify(actual)}\n     want ${JSON.stringify(expected)}`}`);
}

type Seen = { method: string; path: string; version: string | undefined; auth: string | undefined; form: URLSearchParams };
const seen: Seen[] = [];

async function main() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        path: req.url ?? "",
        version: req.headers["stripe-version"] as string | undefined,
        auth: req.headers.authorization,
        form: new URLSearchParams(body),
      });
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && req.url === "/v1/checkout/sessions") {
        res.end(JSON.stringify({ id: "cs_test_1", object: "checkout.session", url: "https://checkout.stripe.com/c/pay/cs_test_1" }));
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/v1/checkout/sessions/cs_test_1")) {
        res.end(JSON.stringify({
          id: "cs_test_1", object: "checkout.session", status: "complete",
          metadata: { offering: "cohort" }, customer_details: { email: "buyer@example.test" },
        }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "no such route" } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const stripe = new Stripe("sk_test_contract", { host: "127.0.0.1", port, protocol: "http", maxNetworkRetries: 0 });
  console.log(`stripe SDK pinned API version: ${Stripe.API_VERSION}`);

  // ── create, inline price_data (the route's default path) ──
  const offering = OFFERINGS.cohort;
  const baseUrl = "https://ai.xl.net";
  const lineItem: Stripe.Checkout.SessionCreateParams.LineItem = {
    quantity: 1,
    price_data: {
      currency: "usd",
      unit_amount: offering.amount,
      product_data: { name: offering.name, description: offering.description },
      ...(offering.mode === "subscription" ? { recurring: { interval: "month" as const } } : {}),
    },
  };
  const session = await stripe.checkout.sessions.create({
    mode: offering.mode,
    line_items: [lineItem],
    success_url: `${baseUrl}/builders/thanks?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/builders?canceled=1`,
    metadata: { offering: offering.id },
    ...(offering.mode === "payment" ? { customer_creation: "always" as const } : {}),
  });
  check("create returns session.url", session.url, "https://checkout.stripe.com/c/pay/cs_test_1");
  const c = seen[0];
  check("create: POST /v1/checkout/sessions", [c.method, c.path], ["POST", "/v1/checkout/sessions"]);
  check("create: Stripe-Version header is the SDK's pinned version", c.version, Stripe.API_VERSION);
  check("create: bearer secret key", c.auth, "Bearer sk_test_contract");
  check("create: form fields", {
    mode: c.form.get("mode"),
    qty: c.form.get("line_items[0][quantity]"),
    currency: c.form.get("line_items[0][price_data][currency]"),
    amount: c.form.get("line_items[0][price_data][unit_amount]"),
    name: c.form.get("line_items[0][price_data][product_data][name]"),
    interval: c.form.get("line_items[0][price_data][recurring][interval]"),
    success: c.form.get("success_url"),
    cancel: c.form.get("cancel_url"),
    meta: c.form.get("metadata[offering]"),
    customer_creation: c.form.get("customer_creation"),
  }, {
    mode: "subscription", qty: "1", currency: "usd", amount: String(offering.amount), name: offering.name,
    interval: "month", success: `${baseUrl}/builders/thanks?session_id={CHECKOUT_SESSION_ID}`,
    cancel: `${baseUrl}/builders?canceled=1`, meta: "cohort", customer_creation: null,
  });
  check("create: payment_method_types is not sent (removed in 2026-09-30.endive)", c.form.has("payment_method_types[0]"), false);

  // ── create, STRIPE_PRICE_COHORT override path + payment-mode customer_creation ──
  seen.length = 0;
  await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: "price_123", quantity: 1 }],
    success_url: `${baseUrl}/builders/thanks?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/builders?canceled=1`,
    metadata: { offering: "cohort" },
    customer_creation: "always",
  });
  check("create (override): price id + customer_creation", {
    price: seen[0].form.get("line_items[0][price]"), cc: seen[0].form.get("customer_creation"),
  }, { price: "price_123", cc: "always" });

  // ── retrieve (thanks page) ──
  seen.length = 0;
  const got = await stripe.checkout.sessions.retrieve("cs_test_1");
  check("retrieve: GET /v1/checkout/sessions/cs_test_1", [seen[0].method, seen[0].path.split("?")[0]], ["GET", "/v1/checkout/sessions/cs_test_1"]);
  check("retrieve: fields the page reads", {
    status: got.status, offering: got.metadata?.offering, email: got.customer_details?.email,
  }, { status: "complete", offering: "cohort", email: "buyer@example.test" });

  // ── API error surfaces as a thrown StripeError (the route catches it -> 502) ──
  let threw = false;
  try { await stripe.checkout.sessions.retrieve("cs_missing"); } catch (e) { threw = e instanceof Stripe.errors.StripeError; }
  check("unknown session throws a Stripe.errors.StripeError", threw, true);

  await new Promise<void>((r) => server.close(() => r()));
  console.log(failures ? `\n${failures} FAILED` : "\nall stripe SDK contract checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
