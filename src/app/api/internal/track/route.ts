import { NextRequest, NextResponse } from "next/server";
import { and, eq, gte } from "drizzle-orm";
import { db } from "@/lib/db";
import { pageVisits } from "@/lib/db/schema";
import { resolveIpOrg } from "@/lib/visitor-id/ip-org-resolver";

// Internal sink for middleware page-view beacons (middleware can't use
// postgres directly — edge-style runtime). Fail closed: without a configured
// secret every request is rejected, and middleware doesn't send any.
const INTERNAL_SECRET = process.env.INTERNAL_TRACK_SECRET;

export async function POST(request: NextRequest) {
  if (!INTERNAL_SECRET || request.headers.get("x-track-secret") !== INTERNAL_SECRET) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: {
    path: string;
    referrer?: string;
    ip: string;
    userAgent: string;
    sessionHash: string;
    landingUrl?: string;
    utmSource?: string;
    utmMedium?: string;
    utmCampaign?: string;
    utmTerm?: string;
    utmContent?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.path || !body.sessionHash) {
    return NextResponse.json({ error: "path and sessionHash required" }, { status: 400 });
  }

  try {
    // Dedup: same session + path within 30s (Next prefetches, double loads)
    const cutoff = new Date(Date.now() - 30_000);
    const recent = await db
      .select({ id: pageVisits.id })
      .from(pageVisits)
      .where(
        and(
          eq(pageVisits.sessionHash, body.sessionHash),
          eq(pageVisits.path, body.path),
          gte(pageVisits.createdAt, cutoff)
        )
      )
      .limit(1);
    if (recent.length > 0) {
      return NextResponse.json({ ok: true, deduped: true });
    }

    await db.insert(pageVisits).values({
      path: body.path,
      landingUrl: body.landingUrl ?? null,
      referrer: body.referrer || null,
      utmSource: body.utmSource ?? null,
      utmMedium: body.utmMedium ?? null,
      utmCampaign: body.utmCampaign ?? null,
      utmTerm: body.utmTerm ?? null,
      utmContent: body.utmContent ?? null,
      ipAddress: body.ip && body.ip !== "unknown" ? body.ip : null,
      userAgent: body.userAgent,
      sessionHash: body.sessionHash,
    });

    // Warm the IP→org cache for the Companies page; never block tracking.
    resolveIpOrg(body.ip).catch(() => {});

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[track] error:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
