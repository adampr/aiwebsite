// XLAnt integration helpers (ARCHITECTURE.md §5.22). SERVER ONLY — this
// module reads the XLAnt shared secret out of the environment and calls the
// relay's internal lane with it; nothing here may be imported from a "use
// client" file (the token button talks to the route handler instead).
//
// IT NO LONGER READS A DISK. Until 2026-09-15 this file also held the
// artifacts-directory readers behind the staff download; the bytes moved to
// xlant.ai that day (see below) and node:fs went with them. What is left is
// identity and the relay.
//
// WHAT XLAnt IS. A separate product in a separate repo (`adampr/xlant`, whose
// ARCHITECTURE.md is the authority for the relay, the desktop and the
// technician): a Windows 11 system-tray app — and, from contract 0.5.0
// (2026-09-05), the same app in the macOS menu bar — that notices when
// something goes wrong on the machine, asks "Can I help attempt to resolve the
// error?", and — only after the user clicks Yes — has an XL.net technician
// agent work the problem through XLAnt while the user watches.
//
// TWO CLIENT KINDS SINCE 0.5.0, and they are separate all the way down: a
// person with both machines holds a `windows` token AND a `mac` token, the
// two are built and published separately (on xlant.ai, since 2026-09-15), and
// neither side can sign the other out.
//
// ONE TOKEN PER COMPUTER SINCE 2026-09-08, AND AS MANY COMPUTERS AS A PERSON
// HAS. Until this round the relay kept ONE active token per (email, kind), so
// every mint signed the person's previous machine of that kind out — measured
// in production on 2026-09-08, one person with two laptops
// (`xl-lpt-aradulovic1` and `…3`) held eight Windows tokens issued since 09-04
// and each set-up killed the other, closing 14 open pieces of work as
// `superseded`. `POST /v1/device/issue` now REVOKES NOTHING AT ALL. A token
// that is never used is dealt with by TIME rather than by the next mint: it
// EXPIRES seven days after it was generated, so a token that got away from
// somebody stops being useful without any other token of theirs being
// disturbed, and generating a second one meanwhile changes nothing about the
// first. Signing a computer out is an explicit act instead: `POST /v1/device/revoke`, which is
// what this host's `/api/internal/xlant/devices/revoke` calls. NOTHING about
// the two kinds changed; what changed is the count within a kind.
//
// THIS HOST WAS THE ONLY PUBLIC ORIGIN FROM 2026-09-04, WAS THE LEGACY FRONT
// FROM 2026-09-13, HAS CARRIED NO DEVICE LANE SINCE 2026-09-15, AND SERVES NO
// BYTES AT ALL SINCE THE SAME DAY. XLAnt's canonical origin is
// `https://xlant.ai`, which serves the DEVICE lane (that repo's
// `src/lib/xlant.ts` and `src/app/api/xlant/**`, a faithful port of what used
// to live here) AND, from this round, the signed-in download at
// `https://xlant.ai/account/download`. What this host carries now, and all it
// carries:
//
//   · IDENTITY — the staff-gated page `/internal/xlant`, which is the
//     token-and-computers page and nothing else: the device-token mint
//     (`/api/internal/xlant/device-token`, one token per COMPUTER since
//     2026-09-08) and the caller's own computer list and sign-out
//     (`GET /api/internal/xlant/devices`,
//     `POST /api/internal/xlant/devices/revoke`), all behind
//     requireXlantStaff(). THESE STAY HERE, and the reason is a fact about
//     cookies rather than a preference: a mint is an act by a member of XL.net
//     staff, authenticated by an XL.net session, and that session lives on the
//     xl.net zone where xlant.ai cannot see it. The shipping desktop also
//     still tells a person their token comes from
//     `https://ai.xl.net/internal/xlant`, and a build in the field never
//     updates its own bundled strings.
//   · BYTES — GONE, 2026-09-15. `/api/internal/xlant/download` was deleted and
//     with it every artifacts-directory reader in this file. XLAnt's installers
//     are published on xlant.ai, and the staff page links there. What proves
//     entitlement over there is the relay's own monthly allowance for the
//     signed-in address — the same relay this file talks to — so nothing was
//     invented to replace this gate.
//   · DEVICE — GONE, 2026-09-15. `/api/xlant/relay/*` (the authenticated
//     passthrough) and `/api/xlant/update/*` (the electron-updater feed) were
//     deleted, and with them everything only they used: the passthrough
//     allowlist, the front-host stamp, the update-manifest names and the
//     device-token verify cache. Nothing under `/api/xlant` exists on this
//     host any more, and a request for one is a plain 404 from Next.
//
// THE RETIREMENT WAS A MEASUREMENT, NOT A GUESS — which is the whole reason
// the front header existed. From 2026-09-13 every relay call this front made
// carried `X-XLAnt-Front: ai.xl.net` (the canonical front sends its own name),
// and the relay recorded it per device (`devices.front_host`) and per
// technician run (`incidents.mcp_origin`). Measured against the relay's own
// database at 2026-09-15T18:30Z: ZERO active devices on
// `front_host='ai.xl.net'`. Every workstation in the field reports 0.13.6 or
// later and `front_host='xlant.ai'`; the last holdout, XL-LPT-JON1, updated to
// 0.13.9 and flipped at 18:30Z. A shipped installer resolves its feed from its
// OWN bundled default rather than from a setting — a new origin cannot be
// pushed to a PC that has not updated — so a count of what the fleet actually
// talks to was the only honest trigger for this deletion. The xlant repo's
// docs/SETUP.md "Cutover to xlant.ai (2026-09-13)" is the runbook; do not
// restate its steps here.
//
// WHAT DID NOT GO WITH IT, and why each stays:
//
//   · The NSG /32 rule opening TCP 8403 from this web host (222; 221 for
//     roleplay was deleted on 2026-09-04, when roleplay.xl.net stopped
//     carrying any of XLAnt). The mint, the sign-out, the computer list and
//     the Mac probe all call the relay's INTERNAL lane from this host's server
//     side, so the path to the relay is still load-bearing — and this round
//     therefore reduces NO attack surface here. Closing that reach is the
//     prize of the day the mint itself moves, not of this one.
//   · XLANT_RELAY_URL and XLANT_PROXY_SHARED_SECRET. See the arming gate
//     below; without them there is no mint, no list and no sign-out.
//   · /opt/xlant-artifacts on this VM, which is now a FROZEN ARCHIVE. The
//     release step stopped copying builds here on 2026-09-15 and nothing in
//     this repo reads the directory any more. Nothing was deleted from it and
//     nothing should be: the owner's standing rule, and the cheapest possible
//     way to keep the last two-front release recoverable.
//
// ARMING GATE, AND IT IS TWO VARS NOW, NOT THREE. XLANT_RELAY_URL and
// XLANT_PROXY_SHARED_SECRET (≥16 chars) must both be present or xlantConfig()
// returns null and all THREE surviving staff route handlers answer 503 — the
// staff page itself still renders, because a page that 500s or 503s tells a
// member of staff nothing they can act on. XLANT_ARTIFACTS_DIR came OUT of
// this gate in the same edit that deleted the download, and the order mattered:
// leaving a var in an all-or-nothing gate that nothing reads means the day an
// operator tidies it out of the VM's .env, the mint and the sign-out 503 at
// once, for a directory nobody was reading. Half-configured is still not a
// state this feature has: guessing a relay URL would send a staff email
// address to whatever answers at the guess.

import { readSession, type SessionData } from "@aicompany/core/auth/session";
import { siteConfig } from "site.config";
import { isRfpDomain, isVerifiedStaffProvider } from "@/lib/rfp/access";

export interface XlantConfig {
  relayUrl: string;
  proxySecret: string;
}

/** Device-token kinds the XLAnt relay accepts — mirrors DEVICE_KINDS in the
 * xlant repo's shared contract (the two repos share no code, so this array and
 * that one move in the same round). `mac` arrived with contract 0.5.0.
 *
 * The kind is not a count and never was: it decides which BUILD a token is
 * for, and a person holds as many tokens of a kind as they have computers of
 * that kind (2026-09-08). What the kind still separates is the install story —
 * a Windows token and a Mac token are for different builds, and only the Mac
 * mint probes the relay first. */
export const XLANT_DEVICE_KINDS = ["windows", "mac"] as const;
export type XlantDeviceKind = (typeof XLANT_DEVICE_KINDS)[number];

export function isXlantDeviceKind(v: unknown): v is XlantDeviceKind {
  return (
    typeof v === "string" &&
    (XLANT_DEVICE_KINDS as readonly string[]).includes(v)
  );
}

/** Both vars, or null. Never a partial config — see the arming gate note. */
export function xlantConfig(): XlantConfig | null {
  const relayUrl = (process.env.XLANT_RELAY_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  const proxySecret = (process.env.XLANT_PROXY_SHARED_SECRET ?? "").trim();
  if (!relayUrl || proxySecret.length < 16) return null;
  return { relayUrl, proxySecret };
}

/** Same three denial reasons readRfpUser() returns, so the two gates cannot
 * drift into describing the same refusal differently. */
export type XlantDenial = "unauthenticated" | "wrong_domain" | "wrong_provider";

/**
 * THE staff gate for every XLAnt route handler on this host: the SAME
 * predicate /rfp uses, assembled from /rfp's OWN exported helpers
 * (src/lib/rfp/access.ts — read its header before touching this). The domain
 * half is `isRfpDomain`, not a local comparison, so an edit to RFP_DOMAINS
 * moves both gates together; the provider half is `isVerifiedStaffProvider`.
 * Admission is therefore exact-label `xl.net` AND a verified staff provider:
 * Google on the Workspace anchor, or Microsoft carrying the per-login
 * `mv: true` claim. There is no new domain check anywhere in this feature — an
 * @xl.net suffix test would admit `evilxl.net`, and a domain-only test would
 * admit any free Entra tenant (MICROSOFT_TENANT_ID is `common`), and what this
 * feature hands out is a token that reaches a technician agent on a real PC.
 *
 * The check ORDER (domain, then provider) mirrors readRfpUser() so a session
 * gets the same reason from both gates. Returns the whole session — the mint
 * needs `email` and `displayName` — or a typed denial, because "no session"
 * and "wrong session" are different answers: 401 vs 403 on the API, and a
 * login redirect vs an explainer on the page. Pages use requireRfpPage()
 * instead, which already does that redirect.
 */
export async function requireXlantStaff(): Promise<
  { ok: true; session: SessionData } | { ok: false; reason: XlantDenial }
> {
  const session = await readSession(siteConfig);
  if (!session) return { ok: false, reason: "unauthenticated" };
  if (!isRfpDomain(session.email)) return { ok: false, reason: "wrong_domain" };
  if (!isVerifiedStaffProvider(session)) {
    return { ok: false, reason: "wrong_provider" };
  }
  return { ok: true, session };
}

/** Authenticated POST to the XLAnt relay's internal lane. The shared secret is
 * the only credential the relay accepts; the NSG rule above decides which web
 * host may reach port 8403 at all. From 2026-09-04 this host was the only one;
 * since 2026-09-13 the canonical front (xlant.ai, on the dev box inside the
 * relay's own VNet) reaches the same port too, with the same secret.
 *
 * Note what is NOT sent: `X-XLAnt-Via: proxy`. The relay hard-rejects its
 * internal routes when they carry that marker, and a front's device
 * passthrough sets it — so the marker is exactly what separates this lane from
 * that one. It still matters here with this host's passthrough gone
 * (2026-09-15): the marker is the relay's rule, not this file's, and the
 * canonical front's passthrough goes on setting it. Nor is `X-XLAnt-Front`
 * sent: that header describes a request a DEVICE made through a front, and
 * this is not one. */
export async function relayInternal(
  cfg: XlantConfig,
  path: string,
  body: Record<string, unknown>
): Promise<Response> {
  return fetch(`${cfg.relayUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-XLAnt-Proxy-Secret": cfg.proxySecret,
    },
    body: JSON.stringify(body),
    // A hung relay must not hold a staff request open until the edge closes
    // it at 100s; 15s is well inside a token mint's real cost.
    signal: AbortSignal.timeout(15_000),
  });
}

/** The same internal lane, read side, for the internal routes this host READS:
 * `GET /v1/status` (the mint's Mac probe) and, since 2026-09-08,
 * `GET /v1/device/list?email=…` (the page's "Your computers" section). Express
 * routes both by METHOD — a POST to either is a 404 — so neither can reuse
 * relayInternal() above. Same secret, same 15s ceiling, same absence of the
 * proxy marker.
 *
 * `path` carries its own query string when it has one, and the CALLER escapes
 * the values (encodeURIComponent): an email address is user-controlled text,
 * and a raw `&` or `#` in one would otherwise invent a second parameter. */
export async function relayInternalGet(
  cfg: XlantConfig,
  path: string
): Promise<Response> {
  return fetch(`${cfg.relayUrl}${path}`, {
    method: "GET",
    headers: { "X-XLAnt-Proxy-Secret": cfg.proxySecret },
    signal: AbortSignal.timeout(15_000),
  });
}

/**
 * What the relay says about Mac support, asked BEFORE a `mac` token is minted.
 *
 * Why ask at all. A relay older than 0.5.0 does not know the word `mac`: its
 * `oneOf(req.body, 'kind', DEVICE_KINDS)` refuses the mint with a generic 400,
 * which this host would report as "relay refused the token mint" — a sentence
 * that sends a member of staff looking for a fault on their side of a
 * perfectly healthy system. The relay reports its own capability instead
 * (`platforms` on GET /v1/status, added in relay 0.5.0), so the page can say
 * the true thing: the Mac lane is not deployed yet.
 *
 * Three answers, because the three need different sentences:
 *
 *   · `supported`   — /v1/status listed 'mac';
 *   · `unsupported` — it answered, and did not. On EVERY relay in production
 *     before 0.5.0 the `platforms` key is simply absent, which is this answer:
 *     a relay that cannot describe its platforms cannot be assumed to have
 *     them;
 *   · `unreadable`  — it did not answer (timeout, DNS, refused), answered a
 *     non-2xx, or answered something that is not JSON. NOT folded into
 *     `unsupported`: "the Mac lane is not deployed" and "the relay is down"
 *     are different problems with different people to tell.
 *
 * Not cached. A mint is a staff button press, not a request path, and one
 * extra 15s-bounded round trip per press is cheaper than a memo that would go
 * on refusing Mac tokens for its whole TTL after the relay is upgraded.
 */
export type XlantMacProbe = "supported" | "unsupported" | "unreadable";

export async function probeRelayMacSupport(
  cfg: XlantConfig
): Promise<XlantMacProbe> {
  let res: Response;
  try {
    res = await relayInternalGet(cfg, "/v1/status");
  } catch {
    return "unreadable";
  }
  if (!res.ok) return "unreadable";
  // A 200 is not a promise of JSON — an intermediary can answer 200 with an
  // HTML error page — and an unguarded .json() would throw out of the mint.
  const json = (await res.json().catch(() => null)) as {
    platforms?: unknown;
  } | null;
  if (!json || typeof json !== "object") return "unreadable";
  const platforms = json.platforms;
  if (!Array.isArray(platforms)) return "unsupported";
  return platforms.includes("mac") ? "supported" : "unsupported";
}

/**
 * ONE COMPUTER, as the relay describes it on its internal
 * `GET /v1/device/list?email=…` (the xlant contract's `DeviceSummary`, marked
 * internal there). Mirrored here rather than imported, like every other shape
 * in this file: the two repos share no code.
 *
 * `machineName` is null until the computer has actually reported an incident —
 * the relay binds it at the first `/incident/start`. That is NOT the same as
 * "has not connected": an install that has said hello and nothing more is
 * connected and still nameless, so the page reads `lastSeenAt` before choosing
 * its words for a null name.
 *
 * `expiresAt` is set only while a token has never connected and is still
 * inside its seven-day window; it is null once the computer has reported in,
 * and null for a row that is not on a clock. It is the only field here the
 * page renders as a COUNTDOWN, which is why it is the only one this host
 * checks is a real instant before passing it on.
 */
export interface XlantDeviceSummary {
  deviceId: string;
  /** null when the relay named a kind this host does not know — a third
   * client kind would arrive here before this file learned the word, and
   * guessing "windows" for a Mac is worse than saying "computer". */
  kind: XlantDeviceKind | null;
  machineName: string | null;
  userName: string | null;
  clientVersion: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  /** ISO instant, or null when the token is not on a clock (see above). */
  expiresAt: string | null;
  openIncidents: number;
}

/** A pure re-read of what the relay sent, so the browser is handed a shape
 * this host has checked rather than whatever arrived.
 *
 * NOT a schema validator and not trying to be: the relay is a trusted peer
 * behind a shared secret and an NSG /32. What this buys is that a field the
 * relay grows, or one it sends as the wrong type, cannot reach the client
 * island as an unrendered object or a "[object Object]" in a table cell — the
 * island renders every field it is given. A non-array (the relay answering
 * something else entirely, or an intermediary's HTML) is `null`, which the
 * route reports as a 502 rather than an empty list, because "you have no
 * computers" and "we could not read your computers" are different sentences.
 *
 * A row with no usable `deviceId` is DROPPED rather than rendered: the id is
 * what the Sign out button posts back, so a row without one is a button that
 * cannot work. Everything else degrades to null / 0. */
function instantOrNull(v: string | null): string | null {
  return v !== null && Number.isFinite(Date.parse(v)) ? v : null;
}

export function xlantDeviceSummaries(
  value: unknown
): XlantDeviceSummary[] | null {
  if (!Array.isArray(value)) return null;
  const out: XlantDeviceSummary[] = [];
  for (const raw of value) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    const deviceId = typeof r.deviceId === "string" ? r.deviceId.trim() : "";
    if (!deviceId) continue;
    const str = (v: unknown): string | null =>
      typeof v === "string" && v.trim() !== "" ? v : null;
    out.push({
      deviceId,
      kind: isXlantDeviceKind(r.kind) ? r.kind : null,
      machineName: str(r.machineName),
      userName: str(r.userName),
      clientVersion: str(r.clientVersion),
      createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
      lastSeenAt: str(r.lastSeenAt),
      // Stricter than its neighbours on purpose: this one becomes "expires in
      // N days" on screen, and a string that is not an instant would become a
      // fabricated countdown or a silently dropped one. Anything that does not
      // parse is null, and the row then says nothing at all about expiry —
      // which is the truthful answer to "we cannot tell".
      expiresAt: instantOrNull(str(r.expiresAt)),
      openIncidents:
        typeof r.openIncidents === "number" &&
        Number.isFinite(r.openIncidents) &&
        r.openIncidents > 0
          ? Math.floor(r.openIncidents)
          : 0,
    });
  }
  return out;
}

/** The shape of a `deviceId` this host will forward to the relay's revoke:
 * 1-80 characters of `[A-Za-z0-9_-]`. The relay decides whether the id is real
 * and whether it is the caller's; this only refuses what could never be an id,
 * so a stray path segment, a query, an `&` or a JSON fragment never reaches
 * the internal lane inside a body field.
 *
 * THE UNDERSCORE IS DELIBERATE — this product's opaque ids (incident ids, tool
 * call ids, bridge tokens) are `[A-Za-z0-9_-]` strings, matching the `[\w-]`
 * the relay's own route shapes use, and a class that omitted `_` would 400 a
 * Sign out button on ids the relay actually issues. What the class still
 * excludes is everything that could mean something somewhere else: no dot, no
 * slash, no `%`, no `&`, no whitespace. */
export const XLANT_DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export function isXlantDeviceId(v: unknown): v is string {
  return typeof v === "string" && XLANT_DEVICE_ID_RE.test(v);
}

// ---------------------------------------------------------------------------
// WHAT USED TO BE HERE, and where it went (2026-09-15). Everything below this
// line was the ARTIFACTS half: `newestArtifact()`, `latestInstaller()`,
// `latestMacBundle()`, `InstallerInfo` / `MacBundleInfo`,
// `XLANT_INSTALLER_RE`, `XLANT_MAC_BUNDLE_RE`, `XLANT_MAC_ARCHES` /
// `isXlantMacArch()`, `safeArtifactName()`, `xlantArtifactContentType()` and
// `xlantDownloadRequest()`. They existed for one caller,
// `/api/internal/xlant/download`, which was deleted with them.
//
// They are not gone from the product. The same filename contracts, the same
// newest-by-mtime-per-architecture rule and the same query-string decision now
// live in the xlantai repo, where the builds are published and where the
// download is served — `src/lib/xlant.ts` and `src/app/api/account/download`
// there. `xlantDownloadRequest()` was carried across verbatim rather than
// rewritten, because its two rules are easy to lose and expensive to lose: no
// query at all means WINDOWS (an old bookmark keeps working), and `arch` is
// REQUIRED for mac with no default (the arm64 and x64 zips are not
// interchangeable, and an Apple-silicon bundle on an Intel Mac does not
// launch).
//
// Deadness was determined by grepping every symbol for remaining callers, not
// by which section of the file it sat in (ARCHITECTURE.md:28's standing rule).
// The device kinds above STAY: the mint reads them, and a kind is not an
// artifact.
// ---------------------------------------------------------------------------
