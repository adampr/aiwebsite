// Transactional email via Resend's REST API (no SDK dependency).
// Sends are best-effort: without RESEND_API_KEY (e.g. until the ai.xl.net
// domain is verified in Resend) this logs and returns false, and callers
// must treat email as optional.
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const MAIL_FROM =
  process.env.MAIL_FROM || "Tron Netter <Tron.Netter@ai.xl.net>";

export async function sendEmail(opts: {
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
}): Promise<boolean> {
  if (!RESEND_API_KEY) {
    console.warn("[email] RESEND_API_KEY not set — skipping send");
    return false;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: MAIL_FROM,
        to: [opts.to],
        subject: opts.subject,
        text: opts.text,
        ...(opts.replyTo && { reply_to: opts.replyTo }),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error(`[email] Resend error ${res.status}: ${errText}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      `[email] send failed: ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }
}
