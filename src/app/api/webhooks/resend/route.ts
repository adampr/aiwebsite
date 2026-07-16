// Resend inbound webhook: host TEE (§5.12 approval loop) over the module
// handler (§5.3). This exact path is the registered Resend inbound-email
// webhook URL for the ai.xl.net domain, so ALL inbound domain mail lands
// here: Tron.Netter@ai.xl.net conversation mail is the module's, and
// Troy.Netter@ai.xl.net budget-approval mail is the host's.
//
// Tee contract (do not weaken): the module handler always receives the
// ORIGINAL, UNREAD Request and performs its own svix verification, so
// Tron's channel cannot regress; the host branch reads only req.clone().
// Every ambiguous case (bad signature, unknown event type, missing
// recipients) delegates to the module unchanged. The module path is skipped
// ONLY when Troy is the sole recipient (otherwise every approval reply
// would fire the module's not-my-mailbox drop alert).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import {
  createInboundEmailHandler,
  verifySvixSignature,
} from "@aicompany/core/channels/email";
import { siteConfig } from "site.config";
import { extractAddress } from "@/lib/governance/approval";
import {
  handleTroyInbound,
  TROY_ADDRESS,
} from "@/lib/governance/approval-inbound";

const moduleHandler = createInboundEmailHandler(siteConfig);

export async function POST(req: Request): Promise<Response> {
  let raw: string;
  try {
    raw = await req.clone().text();
  } catch {
    return moduleHandler(req);
  }

  // Host-branch svix verification (same shared secret; the module re-runs
  // its own verification on the original request when we delegate).
  const verified = verifySvixSignature(
    raw,
    {
      id: req.headers.get("svix-id") ?? "",
      timestamp: req.headers.get("svix-timestamp") ?? "",
      signature: req.headers.get("svix-signature") ?? "",
    },
    process.env.RESEND_WEBHOOK_SECRET ?? ""
  );
  if (!verified) return moduleHandler(req);

  let payload: {
    type?: unknown;
    data?: {
      email_id?: unknown;
      to?: unknown;
      cc?: unknown;
      bcc?: unknown;
      received_for?: unknown;
    };
  };
  try {
    payload = JSON.parse(raw) as typeof payload;
  } catch {
    return moduleHandler(req);
  }
  if (payload?.type !== "email.received" || !payload.data)
    return moduleHandler(req);

  // Route on the envelope truth (received_for) with to/cc/bcc fallback: a
  // BCC'd or alias-delivered approval has Troy absent from to/cc.
  const addrs = new Set<string>();
  for (const field of [
    payload.data.received_for,
    payload.data.to,
    payload.data.cc,
    payload.data.bcc,
  ])
    if (Array.isArray(field))
      for (const r of field)
        if (typeof r === "string") {
          const a = extractAddress(r);
          if (a) addrs.add(a);
        }

  if (!addrs.has(TROY_ADDRESS)) return moduleHandler(req);

  const emailId =
    typeof payload.data.email_id === "string" ? payload.data.email_id : "";
  if (emailId)
    void handleTroyInbound(emailId).catch((err: unknown) =>
      console.log(
        `[gov-approval] tee dispatch failed: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}`
      )
    );

  const troyOnly = addrs.size === 1;
  if (troyOnly) return Response.json({ ok: true });
  // Mixed recipients (e.g. Tron cc'd): the module sees exactly what it sees
  // today and replies as Tron; Troy handles his copy independently.
  return moduleHandler(req);
}
