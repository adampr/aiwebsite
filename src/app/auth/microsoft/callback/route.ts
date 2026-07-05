import { NextRequest, NextResponse } from "next/server";
import { verifyOAuthState, handleOAuthUser, consumeOAuthRedirect } from "@/lib/oauth-helpers";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://ai.xl.net";

  if (!code || !state) {
    return NextResponse.redirect(`${baseUrl}/login?error=missing_params`);
  }

  const valid = await verifyOAuthState(state);
  if (!valid) {
    return NextResponse.redirect(`${baseUrl}/login?error=invalid_state`);
  }

  const tenant = process.env.MICROSOFT_TENANT_ID || "common";

  const tokenRes = await fetch(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.MICROSOFT_CLIENT_ID!,
        client_secret: process.env.MICROSOFT_CLIENT_SECRET!,
        redirect_uri: process.env.MICROSOFT_REDIRECT_URI!,
        grant_type: "authorization_code",
      }),
    }
  );

  if (!tokenRes.ok) {
    return NextResponse.redirect(`${baseUrl}/login?error=token_exchange`);
  }

  const tokens = await tokenRes.json();

  const userRes = await fetch("https://graph.microsoft.com/v1.0/me", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (!userRes.ok) {
    return NextResponse.redirect(`${baseUrl}/login?error=userinfo`);
  }

  const userInfo = await userRes.json();
  const email = (userInfo.mail || userInfo.userPrincipalName) as string;
  const displayName = (userInfo.displayName as string) || null;

  if (!email) {
    return NextResponse.redirect(`${baseUrl}/login?error=no_email`);
  }

  const ip =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";

  const result = await handleOAuthUser(
    email,
    displayName,
    "microsoft",
    ip,
    request.headers.get("user-agent") || ""
  );

  if (!result.ok) {
    return NextResponse.redirect(
      `${baseUrl}/login?error=rejected&message=${encodeURIComponent(result.error)}`
    );
  }

  const destination = await consumeOAuthRedirect();
  return NextResponse.redirect(`${baseUrl}${destination}`);
}
