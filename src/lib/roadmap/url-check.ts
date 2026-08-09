// Reachability checks for admin-supplied URLs (§5.20, phases 09/10/11).
//
// WHY THIS FILE IS WRITTEN THE WAY IT IS. Every other outbound call in this
// codebase targets a CONSTANT host (api.resend.com, api.apollo.io, ...).
// This one fetches a URL a company admin typed, on any port they like, from
// inside the production VM. That is a server-side request forgery primitive
// pointed at our own network, so the module is built as a deny-by-default
// connector rather than a fetch() wrapper:
//
//  1. PARSE and reject anything that is not a plain http(s) URL (no
//     credentials, no control characters, no non-IP-literal host tricks).
//  2. RESOLVE the hostname ONCE, ourselves, and classify EVERY address it
//     returns. One private address in the set fails the whole check: a
//     multi-A record with one public and one private answer is a classic
//     bypass, and we have no control over which one connect() would pick.
//  3. PIN the connection to the address we validated, by passing a custom
//     `lookup` to node:http/node:https. This is what closes DNS rebinding:
//     without it the hostname is resolved a SECOND time at connect, and an
//     attacker-controlled zone can answer 1.2.3.4 to our check and
//     169.254.169.254 to the socket. Verified empirically on this Node
//     (v20): diverting a public name to 127.0.0.1 through the hook produced
//     ECONNREFUSED against 127.0.0.1, proving the hook is authoritative and
//     real DNS is never consulted again.
//  4. FOLLOW redirects manually, re-running steps 1 to 3 on every hop. A
//     public URL that 302s to the metadata service defeats any check that
//     only looks at the URL the admin typed.
//  5. NEVER read a response body, and never echo one. We read status and
//     headers, then destroy the socket. A checker that returned body text
//     would be a full read-SSRF oracle; this one cannot be, by construction.
//
// The failure vocabulary is deliberately COARSE at the network layer: DNS
// failure, connection refused, TLS failure and timeout all collapse into
// one "unreachable" reason. Distinguishing them would let an admin port
// scan our infrastructure by reading our error strings. What we DO
// distinguish is the class the admin can act on: a private/reserved address
// (their URL is not publicly reachable) and an HTTP response we consider a
// failure (their server answered, with what).
//
// NOT a security boundary for CONTENT: a 200 proves a server answered at
// that address. It proves nothing about whether the thing answering is an
// API proxy, is configured correctly, or is secure. Copy must never claim
// otherwise (see url-check-copy.ts).

import dnsPromises from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { siteConfig } from "site.config";

/** How long one hop may take, and the whole check including redirects. */
const HOP_TIMEOUT_MS = 6000;
const TOTAL_BUDGET_MS = 12000;
/**
 * 2, not 3, and the number is an ABUSE bound rather than a compatibility
 * one. One rate-limiter token authorizes one call to this function, and
 * this function can issue several outbound requests: one per redirect hop,
 * plus a GET retry per hop for servers that refuse HEAD. At 3 redirects
 * that was up to 8 requests per token to hosts the caller chose, which
 * makes the checker a traffic amplifier pointed wherever an admin likes.
 * At 2 it is at most 6, and the limiter now spends a token per FIELD rather
 * than per row, halving it again. Two hops still covers the redirects real
 * infrastructure does (http->https, apex->www).
 */
const MAX_REDIRECTS = 2;
/** Longest URL we will store or attempt. */
export const URL_MAX_CHARS = 500;

/** The machine-readable outcome. `ok` is the ONLY thing that may light a
 * step: everything else is saved but does not count (owner rule). */
export type UrlCheckResult =
  | { ok: true; status: number; finalUrl: string }
  | { ok: false; reason: UrlCheckFailReason; status: number | null };

/** User-facing failure classes. Kept coarse on purpose (see header). */
export type UrlCheckFailReason =
  /** Not a URL we will ever attempt (bad scheme, credentials, malformed). */
  | "invalid"
  /** Resolves to a private, loopback, link-local or otherwise reserved
   * address, or to this site itself. Actionable: the URL has to be
   * reachable from the public internet for us to confirm it. */
  | "not_public"
  /** Anything at the network layer: no DNS, refused, reset, TLS failure,
   * timeout. ONE bucket by design, so error strings cannot be used to scan. */
  | "unreachable"
  /** A server answered, with a status we do not accept as proof of life. */
  | "http_status"
  /** Too many redirects, or a redirect without a usable target. */
  | "redirect_loop"
  /** The address points back at this site. Separated from not_public so the
   * copy can say what is actually true: it is a perfectly public address,
   * we just will not point the checker at our own origin. */
  | "self_host";

/**
 * HTTP statuses that COUNT as reachable.
 *
 * The question this check answers is "is there a server answering at this
 * address", not "is the resource public". So an API proxy that correctly
 * demands a key (401/403), one that refuses HEAD (405), and one that is
 * rate limiting us (429) all count: each is a real HTTP conversation with
 * the thing the admin pointed us at, and requiring 200 would fail exactly
 * the correctly-secured proxies this step exists to encourage.
 *
 * 404/410 and 5xx do NOT count: the server answered, but the specific URL
 * the admin saved is wrong or broken, which is the actionable thing to say.
 */
export function statusCounts(status: number): boolean {
  if (status >= 200 && status < 400) return true;
  return status === 401 || status === 403 || status === 405 || status === 429;
}

/** This site's own public hostname, read from the ONE config field that
 * carries it. Deliberately NOT wrapped in a try/catch: an earlier draft
 * read a field that does not exist (`siteConfig.url`), the catch swallowed
 * it, and the self-host defense below was silently inert - the probe caught
 * the checker happily fetching our own front door. A typed read makes a
 * future rename a compile error instead of a dead guard. */
const OWN_HOSTNAME = new URL(siteConfig.site.baseUrl).hostname.toLowerCase();

/** Name suffixes we refuse regardless of what they resolve to. Self-host is
 * a SEPARATE predicate (isSelfHost) so its failure can say something true
 * rather than claiming a public address is unreachable. */
function isDeniedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".home.arpa"))
    return true;
  // THIS SITE ONLY, not the whole registrable domain. An earlier draft also
  // denied the apex and every *.xl.net host, which reads as prudent and is
  // actually wrong twice over: the thing worth preventing is the checker
  // talking to OUR OWN ORIGIN (a request amplifier pointed at ourselves),
  // and xl.net's other hosts are ordinary public servers. Worse, §5.20 puts
  // XL.net itself on the staff lane of these very pages, so denying the
  // apex meant a global admin listing an xl.net-hosted proxy was told their
  // address "is not reachable from the public internet", which is false.
  return false;
}

/** Points back at this site. */
function isSelfHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === OWN_HOSTNAME || h.endsWith(`.${OWN_HOSTNAME}`);
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    // Reject non-canonical forms outright (octal/hex/short-form are handled
    // by net.isIP returning 0, but be explicit).
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

function inV4Cidr(ipInt: number, base: string, bits: number): boolean {
  const b = ipv4ToInt(base);
  if (b === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (b & mask);
}

/** Every IPv4 range we refuse to connect to. */
const V4_BLOCKED: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC1918
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, INCLUDING 169.254.169.254 metadata
  ["172.16.0.0", 12], // RFC1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // RFC1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, includes 255.255.255.255
];

/**
 * Is this literal address one we refuse?
 *
 * IPv4-MAPPED IPv6 IS THE TRAP: ::ffff:127.0.0.1 is a v6 literal that
 * connects to v4 loopback, so a v6-only check that never unwraps it hands
 * an attacker the entire v4 blocklist back. We unwrap first and re-run the
 * v4 rules, and we do the same for NAT64 (64:ff9b::/96).
 */
export function isBlockedAddress(addr: string): boolean {
  const family = net.isIP(addr);
  if (family === 0) return true; // not an address we can reason about: refuse

  if (family === 4) {
    const n = ipv4ToInt(addr);
    if (n === null) return true;
    return V4_BLOCKED.some(([base, bits]) => inV4Cidr(n, base, bits));
  }

  // IPv6. Normalize: strip a zone id, lowercase.
  const raw = addr.toLowerCase().split("%")[0];

  // Unwrap IPv4-mapped (::ffff:a.b.c.d and the all-hex ::ffff:7f00:1 form)
  // and NAT64 (64:ff9b::a.b.c.d), then apply the v4 rules.
  const mapped = unwrapV4(raw);
  if (mapped) return isBlockedAddress(mapped);

  // ANY address whose first hextet is elided ("::...") sits in 0000::/8,
  // which is reserved: ::, ::1, and the v4-compatible/v4-mapped forms all
  // live there. The mapped and NAT64 forms were already unwrapped above and
  // re-checked as IPv4, so anything still starting with "::" here is
  // reserved space and is refused. Without this the classifier read
  // `split(":")[0]` as "" for every such address, parsed it as hextet 0,
  // and sailed past the fc00 / fe80 / ff00 masks.
  if (raw.startsWith("::")) return true;
  const head = raw.split(":")[0];
  const h = parseInt(head || "0", 16);
  if (Number.isNaN(h)) return true;
  if ((h & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((h & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((h & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/** ::ffff:1.2.3.4, ::ffff:0102:0304, and 64:ff9b::1.2.3.4 -> "1.2.3.4". */
function unwrapV4(v6: string): string | null {
  const dotted = v6.match(/:((?:\d{1,3}\.){3}\d{1,3})$/);
  if (dotted && (v6.startsWith("::ffff:") || v6.startsWith("64:ff9b::")))
    return dotted[1];
  const hex = v6.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const a = parseInt(hex[1], 16);
    const b = parseInt(hex[2], 16);
    return `${(a >> 8) & 0xff}.${a & 0xff}.${(b >> 8) & 0xff}.${b & 0xff}`;
  }
  return null;
}

/** Any C0 control, space, or DEL. Written as a code-point scan rather than
 * a regex literal so the source file can never itself contain a raw
 * control byte (which would make it a binary blob to every tool). */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** A parsed, structurally acceptable URL. */
export type ParsedUrl = { url: URL; href: string };

/**
 * Structural validation. Runs on save AND before every hop, so a redirect
 * target gets exactly the same scrutiny as something the admin typed.
 */
export function parseCheckableUrl(raw: string): ParsedUrl | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > URL_MAX_CHARS) return null;
  // Control characters (CR/LF especially) enable request smuggling against
  // whatever is listening; Node would reject most, we reject all.
  if (hasControlChars(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // Credentials in a URL are never needed here and are a phishing vector in
  // rendered links (http://trusted.com@evil.example).
  if (url.username || url.password) return null;
  if (!url.hostname) return null;
  if (url.port) {
    const p = Number(url.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return null;
  }
  return { url, href: url.toString() };
}

/** Resolve + classify. Fails CLOSED: any unusable answer blocks. */
async function resolvePinned(
  hostname: string
): Promise<{ ok: true; address: string; family: number } | { ok: false; reason: UrlCheckFailReason }> {
  if (isSelfHost(hostname)) return { ok: false, reason: "self_host" };
  if (isDeniedHostname(hostname)) return { ok: false, reason: "not_public" };

  // An IP literal never goes to DNS.
  const literal = net.isIP(hostname.replace(/^\[|\]$/g, ""));
  if (literal !== 0) {
    const addr = hostname.replace(/^\[|\]$/g, "");
    if (isBlockedAddress(addr)) return { ok: false, reason: "not_public" };
    return { ok: true, address: addr, family: literal };
  }

  let answers: { address: string; family: number }[];
  try {
    answers = await dnsPromises.lookup(hostname, { all: true });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (!answers.length) return { ok: false, reason: "unreachable" };
  // EVERY answer must be acceptable. If a name resolves to one public and
  // one private address we refuse the whole thing rather than gamble on
  // which one the socket would pick.
  for (const a of answers) {
    if (isBlockedAddress(a.address)) return { ok: false, reason: "not_public" };
  }
  const first = answers[0];
  return { ok: true, address: first.address, family: net.isIP(first.address) };
}

type HopResult =
  | { kind: "response"; status: number; location: string | null }
  | { kind: "error" };

/** One request, pinned to a pre-validated address. Headers only. */
function requestHop(
  url: URL,
  address: string,
  family: number,
  method: "HEAD" | "GET",
  timeoutMs: number
): Promise<HopResult> {
  const mod = url.protocol === "https:" ? https : http;
  return new Promise((resolve) => {
    let settled = false;
    let req: http.ClientRequest | undefined;
    /**
     * WALL-CLOCK cap, and it is not the same thing as the socket timeout
     * below. Node's `timeout` option is an INACTIVITY timer: it fires only
     * after the socket has been quiet for that long, so a host that dribbles
     * one byte every few seconds resets it forever and keeps this request
     * handler (and the admin's POST) open indefinitely. Since the address is
     * chosen by the caller, that is a self-inflicted hang anyone with an
     * admin session could trigger on purpose. This timer cannot be reset by
     * the peer.
     */
    const hardStop = setTimeout(() => {
      try {
        req?.destroy();
      } catch {
        /* already gone */
      }
      done({ kind: "error" });
    }, timeoutMs);
    const done = (r: HopResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardStop);
      resolve(r);
    };
    try {
      req = mod.request({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        timeout: timeoutMs,
        // THE PIN. Node calls this instead of DNS, so the socket can only
        // reach the address resolvePinned already cleared.
        lookup: (_hostname, options, cb) => {
          if (options && (options as { all?: boolean }).all)
            cb(null, [{ address, family }]);
          else cb(null, address, family);
        },
        headers: {
          "user-agent": `${siteConfig.site.name} roadmap link check (+${siteConfig.site.baseUrl})`,
          accept: "*/*",
          // No cookies, no auth, no forwarded headers: this request must
          // never carry ambient authority.
        },
      });
    } catch {
      done({ kind: "error" });
      return;
    }
    req.on("response", (res) => {
      const status = res.statusCode ?? 0;
      const loc = res.headers.location;
      // NEVER read the body. Kill the socket the moment headers land.
      res.destroy();
      req.destroy();
      done({
        kind: "response",
        status,
        location: typeof loc === "string" ? loc : null,
      });
    });
    req.on("timeout", () => {
      req.destroy();
      done({ kind: "error" });
    });
    req.on("error", () => done({ kind: "error" }));
    req.end();
  });
}

/**
 * The public entry point. Returns a verdict and NEVER throws.
 *
 * Callers must treat `ok: false` as "saved, not counted" (owner rule): the
 * value is still stored so the admin can edit or retry it.
 */
export async function checkUrlReachable(raw: string): Promise<UrlCheckResult> {
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const parsed = parseCheckableUrl(raw);
  if (!parsed) return { ok: false, reason: "invalid", status: null };

  let current = parsed.url;
  let method: "HEAD" | "GET" = "HEAD";

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ok: false, reason: "unreachable", status: null };

    // Full re-validation of EVERY hop, including redirect targets.
    const pin = await resolvePinned(current.hostname);
    if (!pin.ok) return { ok: false, reason: pin.reason, status: null };

    const res = await requestHop(
      current,
      pin.address,
      pin.family,
      method,
      Math.min(HOP_TIMEOUT_MS, remaining)
    );
    if (res.kind === "error")
      return { ok: false, reason: "unreachable", status: null };

    // Some servers refuse HEAD outright. Retry the SAME url once with GET
    // (we still never read the body), then treat the answer as final.
    if (
      method === "HEAD" &&
      (res.status === 405 || res.status === 501 || res.status === 400)
    ) {
      method = "GET";
      hop--; // this retry is not a redirect hop
      continue;
    }

    if (res.status >= 300 && res.status < 400) {
      if (!res.location) return { ok: false, reason: "redirect_loop", status: res.status };
      let next: URL;
      try {
        next = new URL(res.location, current);
      } catch {
        return { ok: false, reason: "redirect_loop", status: res.status };
      }
      const nextParsed = parseCheckableUrl(next.toString());
      if (!nextParsed) return { ok: false, reason: "not_public", status: res.status };
      current = nextParsed.url;
      method = "HEAD";
      continue;
    }

    if (statusCounts(res.status))
      return { ok: true, status: res.status, finalUrl: current.toString() };
    return { ok: false, reason: "http_status", status: res.status };
  }
  return { ok: false, reason: "redirect_loop", status: null };
}
