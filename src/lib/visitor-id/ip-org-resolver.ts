import path from "node:path";
import { Reader, AsnResponse } from "mmdb-lib";
import { open, validate } from "maxmind";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { ipOrgs } from "@/lib/db/schema";
import { ISP_ASNS } from "./isp-asns";

export interface IpOrgResult {
  asn: number;
  orgName: string;
  isIsp: boolean;
}

let readerPromise: Promise<Reader<AsnResponse>> | null = null;

function getReader(): Promise<Reader<AsnResponse>> {
  if (!readerPromise) {
    // The .mmdb is NOT in git (12 MB binary): deploy.sh ships it alongside
    // the code and MAXMIND_DB_PATH can point elsewhere. Missing file →
    // resolver quietly returns null and only the Companies page is empty.
    const dbPath =
      process.env.MAXMIND_DB_PATH ||
      path.resolve(process.cwd(), "data", "GeoLite2-ASN.mmdb");
    readerPromise = open<AsnResponse>(dbPath).catch((err) => {
      readerPromise = null;
      throw err;
    });
  }
  return readerPromise;
}

/**
 * Resolve an IP address to its owning organization via MaxMind GeoLite2-ASN.
 * Results are cached in the ip_orgs table so each IP is looked up only once
 * (nulls too, so misses aren't retried). Returns null for invalid/private
 * IPs or when the .mmdb file is absent.
 */
export async function resolveIpOrg(ip: string): Promise<IpOrgResult | null> {
  if (!ip || ip === "unknown" || !validate(ip)) return null;

  const [cached] = await db
    .select({ asn: ipOrgs.asn, orgName: ipOrgs.orgName, isIsp: ipOrgs.isIsp })
    .from(ipOrgs)
    .where(eq(ipOrgs.ipAddress, ip))
    .limit(1);

  if (cached) {
    if (!cached.asn || !cached.orgName) return null;
    return { asn: cached.asn, orgName: cached.orgName, isIsp: cached.isIsp };
  }

  let reader: Reader<AsnResponse>;
  try {
    reader = await getReader();
  } catch {
    return null;
  }

  const result = reader.get(ip);
  const asn = result?.autonomous_system_number ?? null;
  const orgName = result?.autonomous_system_organization ?? null;
  const isIsp = asn ? ISP_ASNS.has(asn) : false;

  try {
    await db
      .insert(ipOrgs)
      .values({ ipAddress: ip, asn, orgName, isIsp })
      .onConflictDoNothing();
  } catch {
    // unique-constraint race — safe to ignore
  }

  if (!asn || !orgName) return null;
  return { asn, orgName, isIsp };
}
