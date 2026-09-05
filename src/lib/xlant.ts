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
// artifacts directory carries a Windows installer feed (`latest.yml`) beside a
// macOS one (`latest-mac.yml`), and neither side can sign the other out.
//
// ONE PUBLIC ORIGIN FROM 2026-09-04, AND IT IS THIS ONE. ai.xl.net carries
// every XLAnt surface a person or a PC reaches, and every NEW device points
// here:
//
//   · HUMAN — the staff-gated page `/internal/xlant`, the build download
//     (`/api/internal/xlant/download`, `?platform=mac&arch=…` for a Mac) and
//     the device-token mint (`/api/internal/xlant/device-token`, one token per
//     kind), all behind requireXlantStaff().
//   · DEVICE — the authenticated relay passthrough
//     (`/api/xlant/relay/*`, allowlisted below) and the electron-updater feed
//     (`/api/xlant/update/*`, gated by verifyDeviceToken() and narrowed to
//     release artifacts by isXlantUpdateArtifact()).
//
// THE MOVE IS COMPLETE. The previous note here said not to move the device
// lane without re-signing and re-publishing the desktop, because the shipped
// installer pins its feed. That was paid: desktop 0.2.1 is re-signed with the
// feed pinned to https://ai.xl.net/api/xlant/update and rewrites a persisted
// roleplay origin at startup. The cutover ran in two phases on 2026-09-04
// because a 0.2.0 build resolves its feed from its OWN bundled default and one
// 0.2.0 desktop was still in service, so roleplay held a bridge until that PC
// updated. It updated (measured: it fetched 0.2.1 through roleplay's feed at
// 15:24Z, has talked only to ai.xl.net since 15:28Z, and roleplay saw no XLAnt
// device traffic after 15:24:33Z), and the bridge came down the same day:
// roleplay.xl.net has carried nothing of XLAnt since 2026-09-04 — branch
// `xlant-retire` (7c01af4) is deployed there, its XLANT_* env lines are gone
// and its /opt/xlant-artifacts is removed.
//
// So ONE NSG /32 rule now opens TCP 8403 to a web host (222, this host; 221
// for roleplay was deleted), and /opt/xlant-artifacts on this VM is the ONLY
// published copy of the builds — latestInstaller(), latestMacBundle() and the
// update feed read it directly and have never proxied anywhere. The xlant repo's
// docs/SETUP.md "Cutover (2026-09-04)" section is the runbook; do not restate
// its steps here.
//
// ARMING GATE. All three env vars must be present (XLANT_RELAY_URL,
// XLANT_PROXY_SHARED_SECRET ≥16 chars, XLANT_ARTIFACTS_DIR) or xlantConfig()
// returns null and all FOUR route handlers answer 503 — the staff page itself
// still renders, with every download reading "not published yet", because a
// page that 500s or 503s tells a member of staff nothing they can act on. Half-configured is not a
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
 * that one move in the same round). `mac` arrived with contract 0.5.0. The
 * relay keeps one ACTIVE token per (user, kind), which is why the two kinds sit
 * in one enum rather than one flag: minting a Mac token revokes the person's
 * previous MAC token and leaves their Windows one alone. */
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
 * the only credential the relay accepts; the NSG rule above decides who may
 * reach port 8403 at all, and from 2026-09-04 this host is the only one that
 * may.
 *
 * Note what is NOT sent: `X-XLAnt-Via: proxy`. The relay hard-rejects its
 * internal routes when they carry that marker, and the passthrough sets it —
 * so the marker is exactly what separates this lane from that one. */
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

/** The same internal lane, read side. `GET /v1/status` is the only internal
 * route this host reads, and express routes it by METHOD — a POST to it is a
 * 404, so the mint's probe cannot reuse relayInternal() above. Same secret,
 * same 15s ceiling, same absence of the proxy marker. */
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
 * repo's publish step; the copy on THIS VM is the one that is read.
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
 * Serve a file from the artifacts dir, refusing traversal and odd names. For
 * the staff download it is defence in depth (that name comes from readdir(),
 * not from a request); for the update feed it is the ACTUAL boundary — the
 * electron-updater asks for `latest.yml`, `XLAnt-Setup-x.y.z.exe` and
 * `<exe>.blockmap` by name, and the name arrives from the network. A single
 * path segment only: the leading class rejects a name starting with `.` or
 * `-`, the body class admits no `/` (so a multi-segment catch-all joined with
 * "/" can never pass), and the explicit `..` test is kept because a future
 * loosening of either class must not silently re-open traversal.
 */
export function safeArtifactName(name: string): boolean {
  return /^[\w][\w.-]*$/.test(name) && !name.includes("..");
}

// ---------------------------------------------------------------------------
// The DEVICE lane (§5.22): what /api/xlant/relay/* may forward, and how
// /api/xlant/update/* checks a device token.
// ---------------------------------------------------------------------------

/**
 * THE ALLOWLIST. A MIRROR of the route list in the xlant repo's
 * `packages/shared/src/contract.ts` (the two repos share no code, and the
 * relay mirrors this same list on its side) — **change the contract and this
 * array together, in the same round**. Exported as data, and paired with the
 * predicate below, so `scripts/xlant-tests.ts` can pin the exact six shapes
 * without standing up a server.
 *
 * Anchored at both ends on purpose. These are the ONLY relay paths reachable
 * from the public internet; everything else the relay serves is an INTERNAL
 * route (`/v1/device/issue`, `/v1/device/verify`, `/v1/status`,
 * `/v1/providers/refresh`) that only this host's server-side code may call,
 * with the shared secret and without `X-XLAnt-Via: proxy`. An unanchored or
 * prefix-matching test would publish the token mint itself.
 *
 * `[\w-]+` for ids and tokens: incident ids, tool call ids and MCP bridge
 * tokens are all opaque `[A-Za-z0-9_-]` strings, so no separator, no dot and
 * no `%2f` can hide a second path segment inside one.
 */
export const XLANT_RELAY_ALLOWED: readonly RegExp[] = [
  /^v1\/device\/hello$/,
  /^v1\/incident\/start$/,
  /^v1\/incident\/[\w-]+\/(events|decision|chat|close)$/,
  /^v1\/incident\/[\w-]+\/tools\/next$/,
  /^v1\/incident\/[\w-]+\/tools\/[\w-]+\/result$/,
  /^v1\/mcp\/[\w-]+$/,
];

/** The one allowlisted path that is NOT a device surface: the Streamable-HTTP
 * MCP endpoint Cursor's cloud VM calls. Those requests carry NO device
 * Authorization header — the per-run bridge token in the PATH is the whole
 * credential and the RELAY authenticates it (unknown ⇒ 404, ended run ⇒ 410),
 * so the passthrough forwards them as they arrive and adds nothing. */
export const XLANT_MCP_PATH = /^v1\/mcp\/[\w-]+$/;

/** `rel` is the catch-all segments joined with "/" — no leading slash, no
 * query string. */
export function isXlantRelayPath(rel: string): boolean {
  return XLANT_RELAY_ALLOWED.some((re) => re.test(rel));
}

/** True for the MCP endpoint, which the passthrough treats differently in one
 * respect only: a body with no declared length is buffered rather than
 * refused (see the relay route). */
export function isXlantMcpPath(rel: string): boolean {
  return XLANT_MCP_PATH.test(rel);
}

/** The updater's manifest filenames, fixed by electron-updater's generic
 * provider: one per platform, both in the same directory. A macOS client asks
 * for `latest-mac.yml` and never for `latest.yml`, and neither manifest names
 * the other's builds, so publishing a Mac release cannot disturb a Windows PC
 * mid-upgrade. */
export const XLANT_UPDATE_MANIFEST = "latest.yml";
export const XLANT_UPDATE_MANIFEST_MAC = "latest-mac.yml";

/**
 * The update feed's RELEASE gate, which is a different question from
 * `safeArtifactName()`'s traversal gate and must not be confused with it. A
 * name can be perfectly safe and still be something this feed has no business
 * publishing: `latest.yml.part` is the publish step's half-written temp file
 * (electron-updater reading one would parse a truncated manifest), and
 * anything else an operator leaves in the directory — a note, a signing log, a
 * pruned build's leftovers — is not a release artifact either.
 *
 * Six shapes are served, all derived from the SAME two regexes the staff
 * downloads use, so a filename convention can only change in one place:
 *
 *   · `latest.yml`                          — the Windows manifest;
 *   · `XLAnt-Setup-<version>.exe`           — the Windows installer;
 *   · `XLAnt-Setup-<version>.exe.blockmap`  — its blockmap;
 *   · `latest-mac.yml`                      — the macOS manifest;
 *   · `XLAnt-<version>-<arm64|x64>-mac.zip` — a macOS bundle;
 *   · that name plus `.blockmap`            — its blockmap.
 *
 * The blockmap arm strips ONE `.blockmap` and re-asks: that is what refuses
 * `…exe.blockmap.blockmap` and a bare `.blockmap`, and it is why the suffix is
 * handled here rather than folded into either regex.
 *
 * Anything else is 404, and the route applies this AFTER the device-token
 * check so the feed never becomes a directory oracle for an anonymous caller.
 */
export function isXlantUpdateArtifact(name: string): boolean {
  if (name === XLANT_UPDATE_MANIFEST || name === XLANT_UPDATE_MANIFEST_MAC) {
    return true;
  }
  const suffix = ".blockmap";
  const base = name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
  return XLANT_INSTALLER_RE.test(base) || XLANT_MAC_BUNDLE_RE.test(base);
}

/**
 * What to put in `Content-Type` for a name this feed (or the staff download)
 * has already accepted. Three answers and no sniffing:
 *
 *   · `.yml`      → `text/yaml`, the manifest electron-updater parses;
 *   · `.zip`      → `application/zip`, the macOS bundle;
 *   · everything else (the `.exe` and both `.blockmap`s) →
 *     `application/octet-stream`.
 *
 * Order matters: `…-mac.zip.blockmap` ends in `.blockmap`, not `.zip`, and is
 * a binary blockmap rather than a zip — so the `.zip` test must be an
 * endsWith on the WHOLE name, which it is.
 *
 * This lives beside the release gate rather than in the route because the two
 * answer the same question about the same name, and `scripts/xlant-tests.ts`
 * can then pin every pair without standing up a server.
 */
export function xlantArtifactContentType(name: string): string {
  if (name.endsWith(".yml")) return "text/yaml";
  if (name.endsWith(".zip")) return "application/zip";
  return "application/octet-stream";
}

// Device-token verification for the update feed, memoized per process so a
// single upgrade (latest.yml, then the .exe, then the .blockmap) does not make
// three relay round-trips. This cache is XLAnt's own; nothing else shares it.
const verifyCache = new Map<string, { until: number }>();
const VERIFY_TTL_MS = 5 * 60_000;
const VERIFY_CACHE_MAX = 500;

/**
 * Is `token` an ACTIVE XLAnt device token? Asked of the relay's internal
 * `POST /v1/device/verify` (200 ⇒ active), through a cache that stores
 * **positives only**:
 *
 *   · a negative result is not cached, because caching it would let a stream
 *     of garbage tokens evict real entries, and — the case that matters —
 *     would lock a genuine token out for the whole TTL after one transient
 *     relay blip mid-download;
 *   · a relay that throws (timeout, DNS, refused) is a negative for THIS
 *     request and is likewise not remembered, so the next request re-asks;
 *   · when the map passes VERIFY_CACHE_MAX entries the OLDEST HALF is evicted
 *     (Map preserves insertion order) rather than the whole map flushed, so a
 *     burst cannot sign every device out at once.
 *
 * The short-token test runs BEFORE any network call: a token shorter than 20
 * characters is not a shape the relay ever mints, and an empty
 * `Authorization: Bearer` must not cost a relay round-trip.
 */
export async function verifyDeviceToken(
  cfg: XlantConfig,
  token: string
): Promise<boolean> {
  if (!token || token.length < 20) return false;
  const hit = verifyCache.get(token);
  if (hit && hit.until > Date.now()) return true;
  let ok = false;
  try {
    const res = await relayInternal(cfg, "/v1/device/verify", { token });
    ok = res.ok;
  } catch {
    ok = false;
  }
  if (ok) {
    if (verifyCache.size > VERIFY_CACHE_MAX) {
      let toDrop = Math.floor(verifyCache.size / 2);
      for (const key of verifyCache.keys()) {
        if (toDrop-- <= 0) break;
        verifyCache.delete(key);
      }
    }
    verifyCache.set(token, { until: Date.now() + VERIFY_TTL_MS });
  }
  return ok;
}

/** Live entry count — for `scripts/xlant-tests.ts` and operator diagnostics.
 * Nothing in the request path reads it. */
export function xlantVerifyCacheSize(): number {
  return verifyCache.size;
}

/** Drop every memoized positive. Used by the tests to isolate legs; in
 * production the TTL and the eviction are the only things that empty it. */
export function resetXlantVerifyCache(): void {
  verifyCache.clear();
}
