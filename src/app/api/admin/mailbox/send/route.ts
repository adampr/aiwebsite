import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guard";
import { sendEmail } from "@/lib/email/send";
import { db } from "@/lib/db";
import { adminEmails } from "@/lib/db/schema";

// Manual send from the Tron Netter mailbox (from: MAIL_FROM, BCC to
// adam@xl.net enforced inside sendEmail). The send is recorded in
// admin_emails so mailbox threads can show human turns alongside the AI
// conversation — Tron himself never sees these, his history lives in
// brain_messages only.
export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  let body: { to?: string; subject?: string; body?: string; sessionId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const to = (body.to ?? "").trim();
  const subject = (body.subject ?? "").trim();
  const text = (body.body ?? "").trim();
  const sessionId = (body.sessionId ?? "").trim() || null;

  if (!/^[\w.+-]+@[\w.-]+\.\w+$/.test(to)) {
    return NextResponse.json({ error: "Valid recipient email required" }, { status: 400 });
  }
  if (!subject || subject.length > 300) {
    return NextResponse.json({ error: "Subject required (max 300 chars)" }, { status: 400 });
  }
  if (!text || text.length > 50_000) {
    return NextResponse.json({ error: "Body required (max 50k chars)" }, { status: 400 });
  }

  const success = await sendEmail({ to, subject, text });

  try {
    await db.insert(adminEmails).values({
      toEmail: to,
      subject,
      body: text,
      sessionId,
      sentBy: auth.session.email,
      success,
    });
  } catch (err) {
    console.error("[admin/mailbox] failed to record send:", err);
  }

  if (!success) {
    return NextResponse.json(
      { error: "Send failed — is RESEND_API_KEY configured?" },
      { status: 502 }
    );
  }
  console.log(`[admin/mailbox] ${auth.session.email} emailed ${to} ("${subject}")`);
  return NextResponse.json({ ok: true });
}
