import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guard";

// Admin SMS console for Tron's number, (872) 350-4325. Reads and sends
// through the Twilio REST API directly — no local storage; replies sent here
// appear in the same list on the next fetch. NOTE: the Twilio account is
// shared with itsupportchicago.net, so queries are always scoped to
// TWILIO_PHONE_NUMBER (To= for inbound, From= for outbound) rather than
// listing account-wide.
const TWILIO_BASE = "https://api.twilio.com/2010-04-01/Accounts";

interface TwilioMessage {
  sid: string;
  direction: string;
  from: string;
  to: string;
  body: string;
  status: string;
  dateSent: string | null;
  dateCreated: string | null;
}

function twilioEnv():
  | { sid: string; token: string; number: string }
  | null {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const number = process.env.TWILIO_PHONE_NUMBER;
  if (!sid || !token || !number) return null;
  return { sid, token, number };
}

function authHeader(sid: string, token: string) {
  return {
    Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
  };
}

function mapMessage(m: Record<string, unknown>): TwilioMessage {
  return {
    sid: String(m.sid),
    direction: String(m.direction),
    from: String(m.from),
    to: String(m.to),
    body: String(m.body ?? ""),
    status: String(m.status),
    dateSent: (m.date_sent as string) ?? null,
    dateCreated: (m.date_created as string) ?? null,
  };
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const env = twilioEnv();
  if (!env) {
    return NextResponse.json(
      { error: "Twilio credentials not configured" },
      { status: 503 }
    );
  }

  const sp = request.nextUrl.searchParams;
  const pageSize = Math.min(Number(sp.get("pageSize")) || 25, 50);
  const direction = sp.get("direction"); // "inbound" | "outbound" | null (both)
  const pageUri = sp.get("pageUri"); // Twilio next-page URI (direction-scoped)

  const headers = authHeader(env.sid, env.token);
  const listUrl = (scope: "inbound" | "outbound") => {
    const params = new URLSearchParams({ PageSize: String(pageSize) });
    params.set(scope === "inbound" ? "To" : "From", env.number);
    return `${TWILIO_BASE}/${env.sid}/Messages.json?${params}`;
  };

  try {
    if (pageUri) {
      const res = await fetch(`https://api.twilio.com${pageUri}`, {
        headers,
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`Twilio ${res.status}`);
      const data = await res.json();
      return NextResponse.json({
        messages: (data.messages ?? []).map(mapMessage),
        nextPageUri: data.next_page_uri ?? null,
      });
    }

    if (direction === "inbound" || direction === "outbound") {
      const res = await fetch(listUrl(direction), { headers, cache: "no-store" });
      if (!res.ok) throw new Error(`Twilio ${res.status}`);
      const data = await res.json();
      return NextResponse.json({
        messages: (data.messages ?? []).map(mapMessage),
        nextPageUri: data.next_page_uri ?? null,
      });
    }

    // Both directions: two scoped queries merged newest-first. First page
    // only — use a direction filter to page further back.
    const [inRes, outRes] = await Promise.all([
      fetch(listUrl("inbound"), { headers, cache: "no-store" }),
      fetch(listUrl("outbound"), { headers, cache: "no-store" }),
    ]);
    if (!inRes.ok || !outRes.ok) {
      throw new Error(`Twilio ${inRes.status}/${outRes.status}`);
    }
    const [inData, outData] = await Promise.all([inRes.json(), outRes.json()]);
    // Twilio dates are RFC-2822 ("Fri, 03 Jul 2026 10:00:00 +0000"), which
    // does NOT sort chronologically as a string — parse to epoch ms first.
    const epoch = (m: TwilioMessage) => {
      const t = Date.parse(m.dateSent ?? m.dateCreated ?? "");
      return isNaN(t) ? 0 : t;
    };
    const merged = [
      ...(inData.messages ?? []).map(mapMessage),
      ...(outData.messages ?? []).map(mapMessage),
    ].sort((a, b) => epoch(b) - epoch(a));
    return NextResponse.json({ messages: merged, nextPageUri: null });
  } catch (err) {
    console.error("[admin/messages] Twilio fetch failed:", err);
    return NextResponse.json(
      { error: "Failed to fetch messages from Twilio" },
      { status: 502 }
    );
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const env = twilioEnv();
  if (!env) {
    return NextResponse.json(
      { error: "Twilio credentials not configured" },
      { status: 503 }
    );
  }

  let body: { to?: string; body?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const to = (body.to ?? "").trim();
  const text = (body.body ?? "").trim();
  if (!/^\+\d{7,15}$/.test(to)) {
    return NextResponse.json(
      { error: "Recipient must be E.164, e.g. +13125551234" },
      { status: 400 }
    );
  }
  if (!text || text.length > 1600) {
    return NextResponse.json(
      { error: "Message body required (max 1600 chars)" },
      { status: 400 }
    );
  }

  try {
    const res = await fetch(`${TWILIO_BASE}/${env.sid}/Messages.json`, {
      method: "POST",
      headers: {
        ...authHeader(env.sid, env.token),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ From: env.number, To: to, Body: text }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error("[admin/messages] Twilio send failed:", res.status, data);
      return NextResponse.json(
        { error: (data as { message?: string }).message || "Twilio send failed" },
        { status: 502 }
      );
    }
    console.log(
      `[admin/messages] ${auth.session.email} sent SMS to ${to} (${String(
        (data as { sid?: string }).sid
      )})`
    );
    return NextResponse.json({ ok: true, sid: (data as { sid?: string }).sid });
  } catch (err) {
    console.error("[admin/messages] Twilio send error:", err);
    return NextResponse.json({ error: "Failed to reach Twilio" }, { status: 502 });
  }
}
