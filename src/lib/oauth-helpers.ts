import crypto from "node:crypto";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { users, authLogs } from "./db/schema";
import { setSessionCookie, type SessionPayload } from "./auth";

const OAUTH_STATE_COOKIE = "aix_oauth_state";
const OAUTH_REDIRECT_COOKIE = "aix_oauth_redirect";
const OAUTH_STATE_MAX_AGE = 600; // 10 minutes

export async function setOAuthStateCookie(redirect?: string): Promise<string> {
  const state = crypto.randomBytes(32).toString("hex");
  const jar = await cookies();
  jar.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: OAUTH_STATE_MAX_AGE,
  });
  if (redirect && redirect.startsWith("/") && !redirect.startsWith("//")) {
    jar.set(OAUTH_REDIRECT_COOKIE, redirect, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: OAUTH_STATE_MAX_AGE,
    });
  } else {
    jar.delete(OAUTH_REDIRECT_COOKIE);
  }
  return state;
}

export async function verifyOAuthState(returnedState: string): Promise<boolean> {
  const jar = await cookies();
  const c = jar.get(OAUTH_STATE_COOKIE);
  jar.delete(OAUTH_STATE_COOKIE);
  if (!c?.value) return false;
  return c.value === returnedState;
}

export async function consumeOAuthRedirect(): Promise<string> {
  const jar = await cookies();
  const c = jar.get(OAUTH_REDIRECT_COOKIE);
  jar.delete(OAUTH_REDIRECT_COOKIE);
  const val = c?.value || "";
  if (val && val.startsWith("/") && !val.startsWith("//")) return val;
  return "/";
}

export async function handleOAuthUser(
  email: string,
  displayName: string | null,
  provider: "google" | "microsoft",
  ip: string,
  userAgent: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const normalized = email.toLowerCase();
  const domain = normalized.split("@")[1];
  if (!domain) {
    await logAuthAttempt(null, normalized, provider, ip, userAgent, false, "invalid email");
    return { ok: false, error: "Invalid email address" };
  }

  const existing = await db.select().from(users).where(eq(users.email, normalized)).limit(1);
  let userId: string;

  if (existing.length > 0) {
    userId = existing[0].id;
    await db
      .update(users)
      .set({ lastLoginAt: new Date(), displayName, authProvider: provider })
      .where(eq(users.id, userId));
  } else {
    const [newUser] = await db
      .insert(users)
      .values({
        email: normalized,
        displayName,
        authProvider: provider,
        emailDomain: domain,
      })
      .returning({ id: users.id });
    userId = newUser.id;
  }

  const payload: SessionPayload = {
    userId,
    email: normalized,
    displayName,
    provider,
  };
  await setSessionCookie(payload);
  await logAuthAttempt(userId, normalized, provider, ip, userAgent, true);

  return { ok: true };
}

async function logAuthAttempt(
  userId: string | null,
  email: string,
  provider: string,
  ip: string,
  userAgent: string,
  success: boolean,
  failureReason?: string
) {
  try {
    await db.insert(authLogs).values({
      userId,
      email,
      authProvider: provider,
      ipAddress: ip,
      userAgent,
      success,
      failureReason: failureReason ?? null,
    });
  } catch {
    console.error("Failed to log auth attempt");
  }
}
