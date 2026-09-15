// XLAnt integration helpers (ARCHITECTURE.md §5.22). SERVER ONLY — this
// module reads node:fs and the XLAnt shared secret out of the environment;
// nothing here may be imported from a "use client" file (the token button
// talks to the route handler instead).
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
// artifacts directory carries a Windows installer beside a macOS bundle per
// architecture, and neither side can sign the other out.
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
// FROM 2026-09-13, AND HAS CARRIED NO DEVICE LANE SINCE 2026-09-15. XLAnt's
// canonical origin is `https://xlant.ai`, which serves the DEVICE lane (that
// repo's `src/lib/xlant.ts` and `src/app/api/xlant/**`, a faithful port of what
// used to live here). What this host carries now, and all it carries:
//
//   · HUMAN — the staff-gated page `/internal/xlant`, the build download
//     (`/api/internal/xlant/download`, `?platform=mac&arch=…` for a Mac), the
//     device-token mint (`/api/internal/xlant/device-token`, one token per
//     COMPUTER since 2026-09-08) and the caller's own computer list and
//     sign-out (`GET /api/internal/xlant/devices`,
//     `POST /api/internal/xlant/devices/revoke`), all behind
//     requireXlantStaff(). THESE STAY HERE: a mint is an act by a member of
//     XL.net staff, authenticated by an XL.net session that lives on this
//     host, and moving that surface is a separate round — the shipping desktop
//     still tells a person their token comes from
//     `https://ai.xl.net/internal/xlant`.
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
//   · /opt/xlant-artifacts on this VM. latestInstaller() and latestMacBundle()
//     read that directory directly for the staff download and have never
//     proxied anywhere; the xlant repo's release step keeps publishing the
//     INSTALLERS to it (it stopped publishing this host's update MANIFESTS —
//     `latest.yml` / `latest-mac.yml` — on the same day, because with the feed
//     gone nothing here reads them). Nothing was deleted from the directory:
//     the manifests already there are simply leftovers now, and the staff
//     readers have never looked at them.
//   · The NSG /32 rule opening TCP 8403 from this web host (222; 221 for
//     roleplay was deleted on 2026-09-04, when roleplay.xl.net stopped
//     carrying any of XLAnt). The mint, the sign-out, the computer list and
//     the Mac probe all call the relay's INTERNAL lane from this host's server
//     side, so the path to the relay is still load-bearing.
//   · All three env vars. See the arming gate below — this module is
//     all-or-nothing, and dropping one would 503 the staff page's every route.
//
// ARMING GATE. All three env vars must be present (XLANT_RELAY_URL,
// XLANT_PROXY_SHARED_SECRET ≥16 chars, XLANT_ARTIFACTS_DIR) or xlantConfig()
// returns null and all FOUR staff route handlers answer 503 — the staff page
// itself still renders, with every download reading "not published yet",
// because a page that 500s or 503s tells a member of staff nothing they can
// act on. Half-configured is not a
// state this feature has: guessing a relay URL would send a staff email
// address to whatever answers at the guess.

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { readSession, type SessionData } from "@aicompany/core/auth/session";
import { siteConfig } from "site.config";
import { isRfpDomain, isVerifiedStaffProvider } from "@/lib/rfp/access";

export interface XlantConfig {
  relayUrl: string;
  proxySecret: string;
  artifactsDir: string;
}

/** Device-token kinds the XLAnt relay accepts — mirrors DEVICE_KINDS in the
 * xlant repo's shared contract (the two repos share no code, so this array and
 * that one move in the same round). `mac` arrived with contract 0.5.0.
 *
 * The kind is not a count and never was: it decides which BUILD a token is
 * for, and a person holds as many tokens of a kind as they have computers of
 * that kind (2026-09-08). What the kind still separates is the install story —
 * a Windows mint and a Mac mint reach different artifacts, and only the Mac
 * mint probes the relay first. */
export const XLANT_DEVICE_KINDS = ["windows", "mac"] as const;
export type XlantDeviceKind = (typeof XLANT_DEVICE_KINDS)[number];

export function isXlantDeviceKind(v: unknown): v is XlantDeviceKind {
  return (
    typeof v === "string" &&
    (XLANT_DEVICE_KINDS as readonly string[]).includes(v)
  );
}

/** The two Mac builds. electron-builder emits one zip per architecture and one
 * shared `latest-mac.yml` naming both, so this host has to be told which one a
 * staffer is asking for — there is no defensible guess: handing an Intel Mac an
 * arm64 bundle produces an app that will not launch. `universal` is
 * deliberately NOT here; the desktop does not build one. */
export const XLANT_MAC_ARCHES = ["arm64", "x64"] as const;
export type XlantMacArch = (typeof XLANT_MAC_ARCHES)[number];

export function isXlantMacArch(v: unknown): v is XlantMacArch {
  return (
    typeof v === "string" && (XLANT_MAC_ARCHES as readonly string[]).includes(v)
  );
}

/** The three vars, or null. Never a partial config — see the arming gate note. */
export function xlantConfig(): XlantConfig | null {
  const relayUrl = (process.env.XLANT_RELAY_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  const proxySecret = (process.env.XLANT_PROXY_SHARED_SECRET ?? "").trim();
  const artifactsDir = (process.env.XLANT_ARTIFACTS_DIR ?? "").trim();
  if (!relayUrl || proxySecret.length < 16 || !artifactsDir) return null;
  return { relayUrl, proxySecret, artifactsDir };
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

export interface InstallerInfo {
  fileName: string;
  size: number;
  version: string;
}

/** A published macOS bundle. Same three fields as an installer plus the
 * architecture, because the page offers one button per architecture and has to
 * label them. */
export interface MacBundleInfo extends InstallerInfo {
  arch: XlantMacArch;
}

/**
 * The installer filename contract. The version is REQUIRED to look like a
 * version (`1.2.3`, optionally `-beta.1`): a loose `[\w.-]+` accepts
 * `XLAnt-Setup-x.exe.exe` and would then present "x.exe" to a member of staff
 * as the version they are downloading. A file that does not match is not an
 * installer this page will serve.
 */
export const XLANT_INSTALLER_RE =
  /^XLAnt-Setup-(\d+\.\d+\.\d+(?:-[\w.]+)?)\.exe$/;

/**
 * The macOS bundle filename contract, and it is electron-builder's, not ours:
 * the desktop's `mac.artifactName` is `XLAnt-${version}-${arch}-mac.${ext}`,
 * which produced `XLAnt-0.4.2-arm64-mac.zip` + `.blockmap` + `latest-mac.yml`
 * on a real `electron-builder --mac zip --arm64` run (measured on the build
 * box, 2026-09-05).
 *
 * THE ARCHITECTURE IS REQUIRED, and that is the load-bearing part of this
 * pattern rather than a decoration. electron-builder's DEFAULT mac pattern is
 * `${productName}-${version}` + (arch === defaultArch ? "" : "-${arch}") +
 * `-${os}.${ext}` and its default arch is x64 (builder-util `arch.js`,
 * `defaultArchFromString(undefined) === Arch.x64`) — so a build that loses the
 * explicit `artifactName` names its Intel zip `XLAnt-0.5.0-mac.zip`, with no
 * architecture in it at all. That name is refused here on purpose: an
 * unlabelled bundle served to whoever clicked "Intel" is a guess, and the
 * publish failing loudly is the outcome worth having.
 *
 * The same reason rules out `universal`: the desktop builds two zips, not
 * three, so `XLAnt-0.5.0-universal-mac.zip` in the directory is somebody's
 * experiment and not a release this feed knows how to describe.
 */
export const XLANT_MAC_BUNDLE_RE =
  /^XLAnt-(\d+\.\d+\.\d+(?:-[\w.]+)?)-(arm64|x64)-mac\.zip$/;

/**
 * Newest file in the artifacts dir matching `accept`, by mtime.
 *
 * The artifacts dir lives OUTSIDE the web root and is filled by the xlant
 * repo's publish step; the copy on THIS VM is the one THIS host reads (since
 * 2026-09-13 the publish step writes the canonical front's copy as well, and
 * the two are kept forward-only independently). Since 2026-09-15 this host's
 * copy receives INSTALLERS ONLY — with the update feed gone, nothing here
 * reads `latest.yml` / `latest-mac.yml`, and the release step no longer
 * publishes them to this VM. The manifests already in the directory were left
 * where they are; they match neither pattern below, so they were never
 * candidates anyway.
 *
 * Newest by mtime, not by parsed version: a republished build of the same
 * version must win, and a version string is not an ordering this host is
 * entitled to invent.
 *
 * Everything here degrades to null rather than throwing, because this runs
 * inside a page render: an unreadable directory, a directory with no match,
 * and — the race that matters — a file that vanishes between readdir() and
 * stat() (the publish step renames `<name>.part` into place and an operator
 * may prune old builds at any moment) all mean "nothing to offer", which the
 * page states plainly. `.part` files are skipped by construction (they do not
 * end in .exe or .zip), and the check is spelled out below so it survives a
 * future loosening of either pattern.
 */
async function newestArtifact(
  artifactsDir: string,
  accept: (name: string) => boolean
): Promise<{ fileName: string; size: number } | null> {
  let names: string[];
  try {
    names = await readdir(artifactsDir);
  } catch {
    return null;
  }
  const candidates = names.filter((n) => !n.endsWith(".part") && accept(n));
  if (candidates.length === 0) return null;

  // One stat per file, and its size is taken from the SAME stat as its mtime:
  // a second stat could observe a different file at the same path.
  const stats = await Promise.all(
    candidates.map(async (fileName) => {
      const st = await stat(join(artifactsDir, fileName)).catch(() => null);
      if (!st || !st.isFile()) return null;
      return { fileName, mtime: st.mtimeMs, size: st.size };
    })
  );
  const present = stats.filter((s): s is NonNullable<typeof s> => s !== null);
  if (present.length === 0) return null;

  present.sort((a, b) => b.mtime - a.mtime);
  const newest = present[0];
  return { fileName: newest.fileName, size: newest.size };
}

/** Newest published Windows installer, or null. */
export async function latestInstaller(
  cfg: XlantConfig
): Promise<InstallerInfo | null> {
  const newest = await newestArtifact(cfg.artifactsDir, (n) =>
    XLANT_INSTALLER_RE.test(n)
  );
  if (!newest) return null;
  return {
    ...newest,
    // Non-null by construction: the name passed XLANT_INSTALLER_RE above.
    version: XLANT_INSTALLER_RE.exec(newest.fileName)![1],
  };
}

/**
 * Newest published macOS bundle FOR ONE ARCHITECTURE, or null.
 *
 * Per architecture rather than "the newest mac zip" because the two are
 * published together and are not interchangeable: the arm64 and x64 zips of
 * one release differ only in mtime, so a single newest-of-all would hand
 * whichever finished writing last to everybody.
 */
export async function latestMacBundle(
  cfg: XlantConfig,
  arch: XlantMacArch
): Promise<MacBundleInfo | null> {
  const newest = await newestArtifact(cfg.artifactsDir, (n) => {
    const m = XLANT_MAC_BUNDLE_RE.exec(n);
    return m !== null && m[2] === arch;
  });
  if (!newest) return null;
  return {
    ...newest,
    // Non-null by construction: the name passed XLANT_MAC_BUNDLE_RE above.
    version: XLANT_MAC_BUNDLE_RE.exec(newest.fileName)![1],
    arch,
  };
}

/**
 * Which build `GET /api/internal/xlant/download` was asked for, decided from
 * the query string alone so every branch is pinnable without a session (the
 * route itself is staff-gated, and `readSession()` needs a Next request scope
 * that `scripts/xlant-tests.ts` has no way to enter).
 *
 * No query at all is the WINDOWS installer: that is the link this host has
 * served since the page existed and the one an old bookmark still carries, and
 * a default that changed under it would hand a member of staff the wrong
 * operating system's build.
 *
 * `arch` is required for mac and has no default. The arm64 and x64 zips are
 * not interchangeable — an Apple-silicon bundle on an Intel Mac does not
 * launch — so there is nothing honest to guess, and the two buttons on the
 * page always name one. It is IGNORED for windows rather than refused: there
 * is one Windows build, and a stray parameter must not break a working link.
 */
export type XlantDownloadRequest =
  | { ok: true; platform: "windows" }
  | { ok: true; platform: "mac"; arch: XlantMacArch }
  | { ok: false; error: string };

export function xlantDownloadRequest(
  params: URLSearchParams
): XlantDownloadRequest {
  const platform = params.get("platform") ?? "windows";
  if (platform === "windows") return { ok: true, platform };
  if (platform !== "mac") {
    return { ok: false, error: "platform must be 'windows' or 'mac'" };
  }
  const arch = params.get("arch");
  if (!isXlantMacArch(arch)) {
    return { ok: false, error: "arch must be 'arm64' or 'x64'" };
  }
  return { ok: true, platform, arch };
}

/**
 * Serve a file from the artifacts dir, refusing traversal and odd names.
 *
 * It guards ONE caller now (the staff download), where it is defence in depth:
 * that name comes from readdir(), not from a request. Until 2026-09-15 it was
 * also the ACTUAL boundary of the update feed, whose names arrived from the
 * network — that feed is gone, and this check is deliberately NOT relaxed to
 * match, because an artifacts directory an operator writes by hand is exactly
 * where a name worth refusing turns up. A single path segment only: the
 * leading class rejects a name starting with `.` or `-`, the body class admits
 * no `/` (so a joined multi-segment path can never pass), and the explicit
 * `..` test is kept because a future loosening of either class must not
 * silently re-open traversal.
 */
export function safeArtifactName(name: string): boolean {
  return /^[\w][\w.-]*$/.test(name) && !name.includes("..");
}

/**
 * What to put in `Content-Type` for a name the staff download has already
 * accepted. Three answers and no sniffing:
 *
 *   · `.yml`      → `text/yaml`, an electron-updater manifest;
 *   · `.zip`      → `application/zip`, the macOS bundle;
 *   · everything else (the `.exe` and both `.blockmap`s) →
 *     `application/octet-stream`.
 *
 * Order matters: `…-mac.zip.blockmap` ends in `.blockmap`, not `.zip`, and is
 * a binary blockmap rather than a zip — so the `.zip` test must be an
 * endsWith on the WHOLE name, which it is.
 *
 * THE WHOLE TABLE IS KEPT, not narrowed to the two names the staff download
 * can actually reach (2026-09-15, when the update feed that served the other
 * four went). It is a total function of a filename and costs nothing; a
 * narrowed one would answer `application/octet-stream` for a `.yml` the day
 * something asked, which is a wrong answer where "no answer" was wanted.
 * `scripts/xlant-tests.ts` pins every pair without standing up a server.
 */
export function xlantArtifactContentType(name: string): string {
  if (name.endsWith(".yml")) return "text/yaml";
  if (name.endsWith(".zip")) return "application/zip";
  return "application/octet-stream";
}
