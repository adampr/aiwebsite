// DKIM readiness detection for roadmap step 05 (§5.18 round 2). Server-only;
// answers: "does the company's email domain publish a currently-usable DKIM
// key at the selectors its mail provider actually signs with?" That is the
// DNS-visible precondition for the email intake's strict-alignment gate
// (email-intake.ts requires dkim=pass with header.d EQUAL to the From
// domain) - which is also why probing the exact companies.domain is correct
// even for subdomain companies.
//
// VERDICT RULES (refutation-hardened; each carries the failure it prevents):
//  - "missing" may rest ONLY on authoritative DNS negatives
//    (ENOTFOUND/ENODATA) for a provider whose selectors are product-fixed
//    (Microsoft 365, Google Workspace). A false "missing" tells a healthy
//    company to change DNS - every indeterminate path degrades to "unknown".
//  - MX classification requires EVERY exchange to match ONE provider's
//    suffix set. Any foreign exchange alongside (Proofpoint/Mimecast primary
//    with a leftover Google row is common) demotes to "other": a gateway may
//    sign d=domain under its own selector, so absence of google._domainkey
//    proves nothing there.
//  - "ok" proves KEY PUBLICATION, not that the provider's signing toggle is
//    on. Copy downstream must say "signing records published", hedge with
//    the Defender/Admin-console toggle, and never claim mail is verified.
//  - A wildcard canary runs before ANY verdict that rests on an ANSWERED
//    record (both the ok path and the answered-but-invalid "revoked" path):
//    zones that wildcard *._domainkey (a real M3AAWG parking pattern)
//    otherwise produce false verdicts in both directions.
//  - TXT character-strings concatenate with NO separator (RFC 6376); a name
//    may hold several TXT records and any valid key wins; a key is valid iff
//    (v absent or v=DKIM1) AND p= present and nonempty base64; p= present
//    and EMPTY is an explicit revocation.
//
// Budgeting: per-query 2s (c-ares honors the Resolver timeout), whole check
// raced against a caller budget (default 2500 ms for the hub render). On
// budget expiry the caller gets a synthetic {verdict:"unknown",
// timedOut:true} that is NEVER cached, while the underlying resolution keeps
// running detached (hard ceiling ~10s via resolver.cancel) and writes the
// REAL result into the cache, so the next render is instant and correct.
// Cache: in-memory per PM2 process, keyed by domain (the tenancy key itself,
// so cross-tenant safe: only that company's members can trigger or read it);
// TTL 10 min for real verdicts, 60s for dns-error. In-flight dedup collapses
// concurrent renders into one resolution.

import { promises as dnsPromises } from "node:dns";
import { domainToASCII } from "node:url";
import crypto from "node:crypto";

export type DkimProvider = "m365" | "google" | "other" | "none";
export type DkimVerdict = "ok" | "missing" | "unknown";
export type DkimReason =
  | "m365-selector-live"
  | "google-selector-live"
  | "other-selector-live"
  | "m365-no-cnames"
  | "m365-cname-dead"
  | "google-absent"
  | "key-revoked"
  | "other-provider"
  | "no-mx"
  | "mx-mixed"
  | "wildcard-dns"
  | "dns-error";

export type DkimCheck = {
  domain: string;
  provider: DkimProvider;
  verdict: DkimVerdict;
  reason: DkimReason;
  selector?: string;
  /** Set ONLY when EVERY MX exchange matches Amazon's inbound-smtp shape
   * (never a bare .amazonaws.com suffix test: EC2/ELB hosts would invent an
   * "Amazon mail" claim for self-hosted servers). Copy-only nicety; verdict
   * and reason are untouched. */
  mxVendor?: "amazon";
  checkedAt: number; // epoch ms
  fromCache: boolean;
  timedOut?: boolean;
};

export interface DnsPort {
  resolveMx(name: string): Promise<{ exchange: string; priority: number }[]>;
  resolveTxt(name: string): Promise<string[][]>;
  resolveCname(name: string): Promise<string[]>;
  cancel(): void;
}

function makePort(): DnsPort {
  const r = new dnsPromises.Resolver({ timeout: 2000, tries: 2 });
  return {
    resolveMx: r.resolveMx.bind(r),
    resolveTxt: r.resolveTxt.bind(r),
    resolveCname: r.resolveCname.bind(r),
    cancel: () => r.cancel(),
  };
}

/** Authoritative negative: the name/record provably does not exist. Anything
 * else (timeout, SERVFAIL incl. DNSSEC-bogus, cancel) is indeterminate. */
function isAuthNegative(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === "ENOTFOUND" || code === "ENODATA";
}

// EVERY exchange must match one set for a confident classification.
const M365_MX_SUFFIXES = [
  ".mail.protection.outlook.com",
  ".mail.protection.office365.us", // GCC High / DoD
  ".mail.protection.partner.outlook.cn", // 21Vianet
];
const GOOGLE_MX_SUFFIXES = [".google.com", ".googlemail.com"];

const OTHER_SELECTORS = ["default", "dkim", "s1", "s2", "k1", "mail", "resend"];

type KeyState = "valid" | "revoked" | "absent" | "indeterminate";

function classifyTxtRecords(records: string[][]): KeyState {
  let sawRevoked = false;
  for (const chunks of records) {
    const txt = chunks.join(""); // RFC 6376: concatenate with NO separator
    const tags = new Map<string, string>();
    for (const part of txt.split(";")) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      tags.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim());
    }
    if (!tags.has("p")) continue; // not a DKIM key record (stray SPF etc.)
    const v = tags.get("v");
    if (v !== undefined && v !== "DKIM1") continue;
    const p = (tags.get("p") ?? "").replace(/\s+/g, "");
    if (p.length === 0) {
      sawRevoked = true; // explicit revocation
      continue;
    }
    if (/^[A-Za-z0-9+/=]+$/.test(p)) return "valid";
  }
  return sawRevoked ? "revoked" : "absent";
}

async function probeSelector(
  port: DnsPort,
  selector: string,
  domain: string
): Promise<KeyState> {
  try {
    const records = await port.resolveTxt(`${selector}._domainkey.${domain}`);
    const state = classifyTxtRecords(records);
    // An answered name with no key-shaped record at all is still "absent"
    // in effect, but it ANSWERED - treat as absent (no key here).
    return state;
  } catch (err) {
    return isAuthNegative(err) ? "absent" : "indeterminate";
  }
}

/** Wildcard canary: a random selector must NOT answer. If it answers with a
 * key-shaped record, every positive/answered result in this zone is
 * untrustworthy. */
async function wildcardActive(port: DnsPort, domain: string): Promise<boolean> {
  const rand = crypto.randomBytes(4).toString("hex");
  try {
    const records = await port.resolveTxt(
      `xl-dkim-canary-${rand}._domainkey.${domain}`
    );
    // Any answer at a random name = wildcard. (Key-shaped or not: an
    // answering zone defeats both the ok and the revoked inference.)
    return records.length > 0;
  } catch {
    return false; // NXDOMAIN (normal) or indeterminate: canary does not veto
  }
}

async function resolveProvider(
  port: DnsPort,
  domain: string
): Promise<{
  provider: DkimProvider | "mixed";
  error?: "no-mx" | "dns-error";
  vendor?: "amazon";
}> {
  try {
    const mx = await port.resolveMx(domain);
    const exchanges = mx
      .map((m) => m.exchange.trim().toLowerCase().replace(/\.$/, ""))
      .filter((e) => e.length > 0);
    if (exchanges.length === 0 || (exchanges.length === 1 && exchanges[0] === ""))
      return { provider: "none", error: "no-mx" };
    // RFC 7505 null MX
    if (exchanges.length === 1 && exchanges[0] === ".")
      return { provider: "none", error: "no-mx" };
    const isM365 = (e: string) => M365_MX_SUFFIXES.some((s) => e.endsWith(s));
    const isGoogle = (e: string) => GOOGLE_MX_SUFFIXES.some((s) => e.endsWith(s));
    if (exchanges.every(isM365)) return { provider: "m365" };
    if (exchanges.every(isGoogle)) return { provider: "google" };
    if (exchanges.some(isM365) && exchanges.some(isGoogle))
      return { provider: "mixed" };
    // Any foreign exchange (gateways like Proofpoint/Mimecast, or leftovers)
    // means a gateway may sign d=domain under its own selector: never
    // eligible for a "missing" verdict.
    const isSesInbound = (e: string) =>
      /(^|\.)inbound-smtp\.[a-z0-9-]+\.amazonaws\.com$/.test(e);
    return {
      provider: "other",
      vendor: exchanges.every(isSesInbound) ? ("amazon" as const) : undefined,
    };
  } catch (err) {
    if (isAuthNegative(err)) return { provider: "none", error: "no-mx" };
    return { provider: "none", error: "dns-error" };
  }
}

/** The full pipeline against an injected DNS port (exported for tests). */
export async function checkDkimWith(
  port: DnsPort,
  rawDomain: string
): Promise<Omit<DkimCheck, "fromCache">> {
  const now = () => Date.now();
  const ascii = domainToASCII(rawDomain.trim().toLowerCase());
  const domain = ascii || "";
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z0-9-]+$/.test(domain)) {
    return {
      domain: rawDomain,
      provider: "none",
      verdict: "unknown",
      reason: "dns-error",
      checkedAt: now(),
    };
  }
  const base = { domain, checkedAt: 0 };
  const done = (
    provider: DkimProvider,
    verdict: DkimVerdict,
    reason: DkimReason,
    selector?: string
  ): Omit<DkimCheck, "fromCache"> => ({
    ...base,
    provider,
    verdict,
    reason,
    ...(selector ? { selector } : {}),
    checkedAt: now(),
  });

  const cls = await resolveProvider(port, domain);
  if (cls.provider === "none")
    return done("none", "unknown", cls.error ?? "no-mx");

  const probeBoth = cls.provider === "mixed";
  const wantM365 = cls.provider === "m365" || probeBoth;
  const wantGoogle = cls.provider === "google" || probeBoth;

  if (wantM365 || wantGoogle) {
    const names: { selector: string; family: "m365" | "google" }[] = [];
    if (wantM365)
      names.push(
        { selector: "selector1", family: "m365" },
        { selector: "selector2", family: "m365" }
      );
    if (wantGoogle) names.push({ selector: "google", family: "google" });
    const states = await Promise.all(
      names.map(async (n) => ({
        ...n,
        state: await probeSelector(port, n.selector, domain),
      }))
    );

    const valid = states.find((s) => s.state === "valid");
    if (valid) {
      // ok only past the wildcard canary.
      if (await wildcardActive(port, domain))
        return done(
          probeBoth ? "other" : (cls.provider as DkimProvider),
          "unknown",
          "wildcard-dns"
        );
      return done(
        valid.family === "m365" ? "m365" : "google",
        "ok",
        valid.family === "m365" ? "m365-selector-live" : "google-selector-live",
        valid.selector
      );
    }
    if (states.some((s) => s.state === "indeterminate"))
      return done(
        probeBoth ? "other" : (cls.provider as DkimProvider),
        "unknown",
        "dns-error"
      );
    if (probeBoth)
      // Migration in progress and no valid key anywhere: never "missing".
      return done("other", "unknown", "mx-mixed");

    const revoked = states.some((s) => s.state === "revoked");
    if (revoked) {
      // An ANSWERED-but-invalid record also needs the canary: an empty-key
      // wildcard (*._domainkey parking) would otherwise fake a revocation.
      if (await wildcardActive(port, domain))
        return done(cls.provider as DkimProvider, "unknown", "wildcard-dns");
      return done(cls.provider as DkimProvider, "missing", "key-revoked");
    }
    // Pure authoritative negatives from here.
    if (cls.provider === "google")
      return done("google", "missing", "google-absent");
    // M365 failure discrimination: CNAMEs installed but chain dead vs no
    // CNAMEs at all (drives the remediation copy). Probe BOTH selectors.
    const cnameStates = await Promise.all(
      ["selector1", "selector2"].map(async (sel) => {
        try {
          const c = await port.resolveCname(`${sel}._domainkey.${domain}`);
          return c.length > 0 ? "present" : "absent";
        } catch (err) {
          return isAuthNegative(err) ? "absent" : "indeterminate";
        }
      })
    );
    if (cnameStates.some((s) => s === "indeterminate"))
      return done("m365", "unknown", "dns-error");
    if (cnameStates.some((s) => s === "absent"))
      return done("m365", "missing", "m365-no-cnames");
    return done("m365", "missing", "m365-cname-dead");
  }

  // provider === "other": a hit can upgrade to ok, misses prove nothing.
  const states = await Promise.all(
    OTHER_SELECTORS.map(async (sel) => ({
      sel,
      state: await probeSelector(port, sel, domain),
    }))
  );
  const hit = states.find((s) => s.state === "valid");
  if (hit) {
    if (await wildcardActive(port, domain))
      return done("other", "unknown", "wildcard-dns");
    return done("other", "ok", "other-selector-live", hit.sel);
  }
  const otherResult = done("other", "unknown", "other-provider");
  return cls.vendor ? { ...otherResult, mxVendor: cls.vendor } : otherResult;
}

// ---- cache + budget wrapper ----

type CacheEntry = { result: DkimCheck; expires: number };
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<DkimCheck>>();
const CACHE_MAX = 500;
const TTL_MS = 600_000;
const ERROR_TTL_MS = 60_000;

function cachePut(domain: string, result: DkimCheck): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  const ttl = result.reason === "dns-error" ? ERROR_TTL_MS : TTL_MS;
  cache.set(domain, { result, expires: Date.now() + ttl });
}

/**
 * Cached, budget-bounded check. `fresh` (the Recheck button) bypasses the
 * cache read but still populates it. On budget expiry the synthetic
 * timed-out "unknown" is returned UNCACHED while the resolution continues
 * detached (ceiling ~10s) and writes the real result to cache.
 */
export async function checkDkim(
  rawDomain: string,
  opts?: { fresh?: boolean; budgetMs?: number }
): Promise<DkimCheck> {
  const domain = rawDomain.trim().toLowerCase();
  const budgetMs = opts?.budgetMs ?? 2500;
  if (!opts?.fresh) {
    const hit = cache.get(domain);
    if (hit && hit.expires > Date.now())
      return { ...hit.result, fromCache: true };
  }
  let run = inflight.get(domain);
  if (!run || opts?.fresh) {
    const port = makePort();
    const ceiling = setTimeout(() => port.cancel(), 10_000);
    run = checkDkimWith(port, domain)
      .then((r) => {
        const result: DkimCheck = { ...r, fromCache: false };
        cachePut(domain, result);
        return result;
      })
      .catch((): DkimCheck => {
        const result: DkimCheck = {
          domain,
          provider: "none",
          verdict: "unknown",
          reason: "dns-error",
          checkedAt: Date.now(),
          fromCache: false,
        };
        cachePut(domain, result);
        return result;
      })
      .finally(() => {
        clearTimeout(ceiling);
        inflight.delete(domain);
      });
    inflight.set(domain, run);
  }
  const timeout = new Promise<DkimCheck>((resolve) =>
    setTimeout(
      () =>
        resolve({
          domain,
          provider: "none",
          verdict: "unknown",
          reason: "dns-error",
          checkedAt: Date.now(),
          fromCache: false,
          timedOut: true,
        }),
      budgetMs
    )
  );
  return Promise.race([run, timeout]);
}
