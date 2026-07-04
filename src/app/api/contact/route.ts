import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { contactSubmissions } from "@/lib/db/schema";
import { sendEmail } from "@/lib/email/send";

const CONTACT_NOTIFY_EMAIL =
  process.env.CONTACT_NOTIFY_EMAIL || "ai@xl.net";

const rateLimitMap = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const windowMs = 60_000;
  const maxRequests = 5;

  const timestamps = rateLimitMap.get(ip) || [];
  const recent = timestamps.filter((t) => now - t < windowMs);
  rateLimitMap.set(ip, recent);

  if (recent.length >= maxRequests) return true;
  recent.push(now);
  return false;
}

export async function POST(request: NextRequest) {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";

  if (isRateLimited(ip)) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { name, email, company, phone, message } = body as {
    name?: string;
    email?: string;
    company?: string;
    phone?: string;
    message?: string;
  };

  if (!name?.trim() || !email?.trim() || !message?.trim()) {
    return NextResponse.json(
      { error: "Name, email, and message are required." },
      { status: 400 }
    );
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email.trim())) {
    return NextResponse.json(
      { error: "Please provide a valid email address." },
      { status: 400 }
    );
  }

  try {
    await db.insert(contactSubmissions).values({
      name: name.trim(),
      email: email.trim(),
      company: company?.trim() || null,
      phone: phone?.trim() || null,
      message: message.trim(),
      ipAddress: ip !== "unknown" ? ip : null,
    });
  } catch (err) {
    console.error("[contact] DB insert error:", err);
    return NextResponse.json(
      { error: "Failed to save submission. Please try again." },
      { status: 500 }
    );
  }

  // Email notification is best-effort — the submission is already saved.
  sendEmail({
    to: CONTACT_NOTIFY_EMAIL,
    subject: `ai.xl.net contact form: ${name.trim()}`,
    replyTo: email.trim(),
    text: [
      `Name: ${name.trim()}`,
      `Email: ${email.trim()}`,
      company?.trim() ? `Company: ${company.trim()}` : null,
      phone?.trim() ? `Phone: ${phone.trim()}` : null,
      "",
      message.trim(),
    ]
      .filter((l) => l !== null)
      .join("\n"),
  }).catch((err) => console.error("[contact] notify email failed:", err));

  return NextResponse.json({ success: true });
}
