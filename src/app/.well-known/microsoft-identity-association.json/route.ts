// GET /.well-known/microsoft-identity-association.json (§5.18 round 2):
// Microsoft's publisher-domain verification handshake. Entra's "Verify and
// save domain" flow fetches this file over HTTPS (no redirects) and requires
// content-type application/json with the app registration's client id in
// associatedApplications; once it matches, the OAuth consent screen shows
// ai.xl.net as the publisher domain instead of the "unverified" banner.
// The client id is public by nature (it rides in every OAuth URL).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const appId = process.env.MICROSOFT_CLIENT_ID ?? "";
  if (!appId) return new Response("not configured", { status: 404 });
  return new Response(
    JSON.stringify({ associatedApplications: [{ applicationId: appId }] }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=3600",
      },
    }
  );
}
