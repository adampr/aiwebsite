/**
 * /rfp access-gate assertions (ARCHITECTURE.md §5.17).
 *
 *   npm run build && npm run start &        # or any running instance
 *   RFP_TEST_BASE=http://127.0.0.1:3000 npm run test:rfp
 *
 * Mints signed sessions with the real SESSION_COOKIE_SECRET and asserts who
 * the gate admits. Case 5 is the one that matters: a VALIDLY SIGNED session
 * claiming an @xl.net address via Microsoft must still be refused, because
 * MICROSOFT_TENANT_ID is "common" and Entra's `mail` attribute is not a
 * verified-domain claim. If that case ever returns GRANTED, the section is
 * open to anyone willing to create a free tenant.
 */

import "dotenv/config";
import crypto from "node:crypto";

const SECRET = process.env.SESSION_COOKIE_SECRET!;
function sign(payload: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({ iat: now, exp: now + 3600, ...payload }), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}
const BASE = process.env.RFP_TEST_BASE ?? "http://127.0.0.1:3000";

async function hit(label: string, cookie: string | null, path = "/rfp") {
  const res = await fetch(BASE + path, {
    redirect: "manual",
    headers: cookie ? { cookie: `aix_session=${cookie}` } : {},
  });
  const body = res.status === 200 ? await res.text() : "";
  const denied = body.includes("Staff access only");
  const granted = body.includes("Knowledge base") || body.includes("Live facts");
  console.log(
    `${label.padEnd(42)} ${String(res.status).padEnd(4)} ${
      res.status === 307 || res.status === 302 ? "-> " + res.headers.get("location")
      : denied ? "DENIED (explained)" : granted ? "GRANTED" : "200 (other)"
    }`
  );
  return { status: res.status, denied, granted };
}

async function main() {
  console.log("path                                       code  outcome");
  console.log("-".repeat(78));
  const r1 = await hit("1 no cookie", null);
  const r2 = await hit("2 valid session, gmail.com", sign({ userId: "u1", email: "someone@gmail.com", provider: "google" }));
  const r3 = await hit("3 valid session, evilxl.net", sign({ userId: "u2", email: "a@evilxl.net", provider: "google" }));
  const r4 = await hit("4 valid session, ai.xl.net subdomain", sign({ userId: "u3", email: "Tron.Netter@ai.xl.net", provider: "google" }));
  const r5 = await hit("5 xl.net via MICROSOFT (forgery path)", sign({ userId: "u4", email: "adam@xl.net", provider: "microsoft" }));
  const r6 = await hit("6 xl.net via GOOGLE (real staff)", sign({ userId: "u5", email: "adam@xl.net", provider: "google" }));
  const r7 = await hit("7 tampered signature", sign({ userId: "u6", email: "adam@xl.net", provider: "google" }).replace(/.$/, "X"));
  const r8 = await hit("8 xl.net google -> /rfp/knowledge", sign({ userId: "u7", email: "a@xl.net", provider: "google" }), "/rfp/knowledge");

  console.log("-".repeat(78));
  const pass =
    r1.status === 307 && r2.denied && r3.denied && r4.denied &&
    r5.denied && r6.granted && r7.status === 307 && r8.granted;
  console.log(pass ? "ALL GATE ASSERTIONS PASSED" : "*** GATE FAILURE ***");
  process.exit(pass ? 0 : 1);
}
main();
