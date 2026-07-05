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

  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://ai.xl.net";
    return NextResponse.redirect(`${baseUrl}/login?error=provider_unconfigured`);
  }

  const redirect = request.nextUrl.searchParams.get("redirect") || undefined;
  const state = await setOAuthStateCookie(redirect);

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI!,
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "online",
    prompt: "select_account",
  });

  return NextResponse.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params}`
  );
}
