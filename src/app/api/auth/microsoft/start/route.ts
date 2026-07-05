import { NextRequest, NextResponse } from "next/server";
import { setOAuthStateCookie } from "@/lib/oauth-helpers";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

export async function GET(request: NextRequest) {
  const ip =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";

  const rl = checkRateLimit(`oauth_start:${ip}`, RATE_LIMITS.oauthStartPerIp);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Try again later." },
      { status: 429 }
    );
  }

  const redirect = request.nextUrl.searchParams.get("redirect") || undefined;
  const state = await setOAuthStateCookie(redirect);
  const tenant = process.env.MICROSOFT_TENANT_ID || "common";

  const params = new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID!,
    redirect_uri: process.env.MICROSOFT_REDIRECT_URI!,
    response_type: "code",
    scope: "openid email profile User.Read",
    state,
    response_mode: "query",
    prompt: "select_account",
  });

  return NextResponse.redirect(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${params}`
  );
}
