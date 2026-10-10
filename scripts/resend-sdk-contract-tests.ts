/**
 * Resend SDK contract tests (ARCHITECTURE.md §5 work intake).
 *
 *   npm run test:resendsdk
 *
 * Pure, no network, no key: global fetch is stubbed. Pins the THREE Resend
 * SDK calls that run on this host with its own resend package:
 *   1. src/lib/work/email-intake.ts:476-477
 *        new Resend(key); resend.emails.receiving.get(emailId) -> { data: email, error }
 *   2. src/lib/work/email-intake.ts:2018-2027 downloadAttachment
 *        resend.emails.receiving.attachments.get({ emailId, id }) -> { data.download_url, error },
 *        then a plain fetch of data.download_url
 *   3. packages/aicompany/src/channels/email-inbound.ts:1808-1810 (the module,
 *        resolved against THIS site's resend) - the same receiving.get as (1)
 * (every other Resend call in this repo is a raw fetch to api.resend.com).
 * Checked: the export shape, each request (method, path, Bearer key), the
 * success envelopes (incl. the download_url field the site fetches) and that
 * an API error comes back in `error` instead of throwing. Added by the
 * 2026-10-09 dependency-upgrade train (resend 6.17.1 -> 6.32.1); call 2 and
 * the module call-site note added after the 2026-10-10 refute (F1).
 */
import { isDeepStrictEqual } from "node:util";
import { Resend } from "resend";

const RESEND_API = "https://api.resend.com";
let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = isDeepStrictEqual(actual, expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `\n     got  ${JSON.stringify(actual)}\n     want ${JSON.stringify(expected)}`}`);
}

type Call = { url: string; method: string; auth: string | null };
let calls: Call[] = [];
function stubFetch(status: number, body: unknown) {
  calls = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    calls.push({ url: String(input), method: (init?.method ?? "GET").toUpperCase(), auth: h.get("authorization") });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

async function main() {
  const realFetch = globalThis.fetch;
  const realError = console.error;
  delete process.env.RESEND_BASE_URL;
  try {
    const resend = new Resend("re_test_contract");
    check("emails.receiving.get is a function", typeof resend.emails.receiving.get, "function");

    stubFetch(200, { id: "in_1", from: "a@example.test", subject: "Tool: X", text: "body", headers: {} });
    const ok = await resend.emails.receiving.get("in_1");
    check("success: error is null", ok.error, null);
    check("success: data fields", { id: ok.data?.id, from: ok.data?.from, subject: ok.data?.subject }, { id: "in_1", from: "a@example.test", subject: "Tool: X" });
    check("request: one GET to /emails/receiving/<id> with the bearer key", calls, [
      // Built from parts so scripts/check-resend-headers.mjs (which counts the
      // literal send URL) does not count this GET of a RECEIVED email as a send.
      { url: [RESEND_API, "emails", "receiving", "in_1"].join("/"), method: "GET", auth: "Bearer re_test_contract" },
    ]);

    console.error = () => {};
    stubFetch(404, { name: "not_found", statusCode: 404, message: "Email not found" });
    const bad = await resend.emails.receiving.get("missing");
    console.error = realError;
    check("error: data is null", bad.data, null);
    check("error: message and statusCode in `error` (no throw)", { m: bad.error?.message, s: bad.error?.statusCode }, { m: "Email not found", s: 404 });

    // ── (2) attachments.get -> download_url (email-intake.ts downloadAttachment) ──
    stubFetch(200, { object: "attachment", id: "att_1", filename: "tool.zip", content_type: "application/zip", size: 10, download_url: "https://cdn.resend.app/att/att_1?sig=x", expires_at: "2026-10-10T00:00:00Z" });
    const att = await resend.emails.receiving.attachments.get({ emailId: "in_1", id: "att_1" });
    check("attachments.get: error is null", att.error, null);
    check("attachments.get: download_url present (the site fetches it)", att.data?.download_url, "https://cdn.resend.app/att/att_1?sig=x");
    check("attachments.get request: one GET to /emails/receiving/<emailId>/attachments/<id> with the bearer key", calls, [
      { url: [RESEND_API, "emails", "receiving", "in_1", "attachments", "att_1"].join("/"), method: "GET", auth: "Bearer re_test_contract" },
    ]);
    console.error = () => {};
    stubFetch(404, { name: "not_found", statusCode: 404, message: "Attachment not found" });
    const attBad = await resend.emails.receiving.attachments.get({ emailId: "in_1", id: "missing" });
    console.error = realError;
    check("attachments.get error: data null, message in `error` (no throw)", { d: attBad.data, m: attBad.error?.message }, { d: null, m: "Attachment not found" });
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
  }
  console.log(failures ? `\n${failures} FAILED` : "\nall resend SDK contract checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
