// Minimal Twilio REST sender shared by the Tron Netter SMS webhook reply
// path and the /texting phone-verification flow. No SDK — one form-encoded
// POST with Basic auth, same as the admin messages proxy.

export async function sendSms(to: string, body: string, from?: string): Promise<void> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID || "";
  const authToken = process.env.TWILIO_AUTH_TOKEN || "";
  const fromNumber = from || process.env.TWILIO_PHONE_NUMBER || "";
  if (!accountSid || !authToken || !fromNumber) {
    throw new Error("Twilio credentials not configured");
  }
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      // Twilio splits long bodies into segments; hard-cap well below its
      // 1600-char limit in case a caller passes something oversized.
      body: new URLSearchParams({ To: to, From: fromNumber, Body: body.slice(0, 1200) }),
      signal: AbortSignal.timeout(30_000),
    }
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Twilio send error ${res.status}: ${errText}`);
  }
}
