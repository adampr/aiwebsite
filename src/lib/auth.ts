import crypto from "node:crypto";
import { cookies } from "next/headers";

export interface SessionPayload {
  userId: string;
  email: string;
  displayName: string | null;
  provider: "google" | "microsoft";
  // Unix seconds; stamped by signSessionCookie, enforced by verifySessionCookie.
  // Callers never set these — any values passed in are overwritten at signing.
  iat?: number;
  exp?: number;
}

const COOKIE_NAME = "aix_session";
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days

function getSecret(): string {
  const s = process.env.SESSION_COOKIE_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_COOKIE_SECRET must be set (≥32 chars)");
  return s;
}

export function signSessionCookie(payload: SessionPayload): string {
  const secret = getSecret();
  const now = Math.floor(Date.now() / 1000);
  const stamped: SessionPayload = { ...payload, iat: now, exp: now + COOKIE_MAX_AGE };
  const body = Buffer.from(JSON.stringify(stamped), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifySessionCookie(cookieValue: string | undefined): SessionPayload | null {
  if (!cookieValue) return null;
  const secret = getSecret();
  const [body, sig] = cookieValue.split(".");
  if (!body || !sig) return null;

  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  try {
    const payload: SessionPayload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export async function setSessionCookie(payload: SessionPayload): Promise<void> {
  const token = signSessionCookie(payload);
  const jar = await cookies();
  jar.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
}

export async function getSession(): Promise<SessionPayload | null> {
  const jar = await cookies();
  const c = jar.get(COOKIE_NAME);
  return verifySessionCookie(c?.value);
}

export async function clearSession(): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export function isAdmin(email: string): boolean {
  const admins = (process.env.ADMIN_EMAIL || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(email.toLowerCase());
}
