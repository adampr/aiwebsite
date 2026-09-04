// XLAnt integration helpers (ARCHITECTURE.md §5.22). SERVER ONLY — this
// module reads node:fs and the XLAnt shared secret out of the environment;
// nothing here may be imported from a "use client" file (the token button
// talks to the route handler instead).
//
// WHAT XLAnt IS. A separate product in a separate repo (`adampr/xlant`, whose
// ARCHITECTURE.md is the authority for the relay, the desktop and the
// technician): a Windows 11 system-tray app that notices when something goes
// wrong on the PC, asks "Can I help attempt to resolve the error?", and — only
// after the user clicks Yes — has an XL.net technician agent work the problem
// through XLAnt while the user watches.
//
// ONE PUBLIC ORIGIN FROM 2026-09-04, AND IT IS THIS ONE. ai.xl.net carries
// every XLAnt surface a person or a PC reaches, and every NEW device points
// here:
//
//   · HUMAN — the staff-gated page `/internal/xlant`, the installer download
//     (`/api/internal/xlant/download`) and the device-token mint
//     (`/api/internal/xlant/device-token`), all behind requireXlantStaff().
//   · DEVICE — the authenticated relay passthrough
//     (`/api/xlant/relay/*`, allowlisted below) and the electron-updater feed
//     (`/api/xlant/update/*`, gated by verifyDeviceToken() and narrowed to
//     release artifacts by isXlantUpdateArtifact()).
//
// THE CUTOVER IS TWO-PHASE, AND PHASE 2 HAS NOT HAPPENED. The previous note
// here said not to move the device lane without re-signing and re-publishing
// the desktop, because the shipped installer pins its feed. That is paid:
// desktop 0.2.1 is re-signed with the feed pinned to
// https://ai.xl.net/api/xlant/update and rewrites a persisted roleplay origin
// at startup. But a 0.2.0 build resolves its feed from its OWN bundled
// default, and one 0.2.0 desktop is in service (measured: hello + latest.yml
// against roleplay.xl.net at 14:01Z and 14:16Z on 2026-09-04), so roleplay
// cannot be switched off underneath it.
//
//   · PHASE 1 (this commit): this host serves the device lane, the relay's
//     public base URL points here, and 0.2.1 is published to BOTH hosts'
//     /opt/xlant-artifacts. roleplay KEEPS its copies of both routes, its
//     XLANT_* env and NSG rule 221 (157.55.165.83/32) as the transitional
//     bridge that the 0.2.0 desktop keeps using until it updates.
//   · PHASE 2 (PENDING; trigger: that desktop's first hello arriving via
//     ai.xl.net in this VM's /var/log/nginx/aiwebsite.access.log): roleplay's
//     branch `xlant-retire` (7c01af4) deploys, NSG rule 221 is deleted,
//     roleplay's XLANT_* env lines and its artifacts go, and publishing
//     returns to ai.xl.net only.
//
// The xlant repo's docs/SETUP.md "Cutover (2026-09-04)" section is the
// runbook; do not restate its steps here. Until phase 2 lands, TWO NSG /32
// rules still open TCP 8403 (222 for this host, 221 for roleplay) and the
// installers exist on both VMs — latestInstaller() and the update feed read
// THIS host's copy either way, never roleplay's.
//
// ARMING GATE. All three env vars must be present (XLANT_RELAY_URL,
// XLANT_PROXY_SHARED_SECRET ≥16 chars, XLANT_ARTIFACTS_DIR) or xlantConfig()
// returns null and all FOUR route handlers answer 503 — the staff page itself
// still renders, minus the installer offer, because a page that 500s or 503s
// tells a member of staff nothing they can act on. Half-configured is not a
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
 * xlant repo's shared contract (the two repos share no code). Windows is the
 * only client today; the enum exists so a second kind never changes the wire
 * shape. The relay keeps one active token per (user, kind). */
export const XLANT_DEVICE_KINDS = ["windows"] as const;
export type XlantDeviceKind = (typeof XLANT_DEVICE_KINDS)[number];

export function isXlantDeviceKind(v: unknown): v is XlantDeviceKind {
  return (
    typeof v === "string" &&
    (XLANT_DEVICE_KINDS as readonly string[]).includes(v)
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
 * may. */
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

export interface InstallerInfo {
  fileName: string;
  size: number;
  version: string;
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
 * Newest published installer in the artifacts dir (which lives OUTSIDE the web
 * root and is filled by the xlant repo's publish step — see the two-origins
 * note above; the copy on THIS VM is the one that is read).
 *
 * Newest by mtime, not by parsed version: a republished build of the same
 * version must win, and a version string is not an ordering this host is
 * entitled to invent.
 *
 * Everything here degrades to null rather than throwing, because this runs
 * inside a page render: an unreadable directory, a directory with no match,
 * and — the race that matters — a file that vanishes between readdir() and
 * stat() (the publish step renames `<name>.part` into place and an operator
 * may prune old builds at any moment) all mean "no installer to offer", which
 * the page states plainly. `.part` files are skipped by construction (they do
 * not end in .exe), and the check is spelled out below so it survives a future
 * loosening of the pattern.
 */
export async function latestInstaller(
  cfg: XlantConfig
): Promise<InstallerInfo | null> {
  let names: string[];
  try {
    names = await readdir(cfg.artifactsDir);
  } catch {
    return null;
  }
  const candidates = names.filter(
    (n) => !n.endsWith(".part") && XLANT_INSTALLER_RE.test(n)
  );
  if (candidates.length === 0) return null;

  // One stat per file, and its size is taken from the SAME stat as its mtime:
  // a second stat could observe a different file at the same path.
  const stats = await Promise.all(
    candidates.map(async (fileName) => {
      const st = await stat(join(cfg.artifactsDir, fileName)).catch(() => null);
      if (!st || !st.isFile()) return null;
      return { fileName, mtime: st.mtimeMs, size: st.size };
    })
  );
  const present = stats.filter((s): s is NonNullable<typeof s> => s !== null);
  if (present.length === 0) return null;

  present.sort((a, b) => b.mtime - a.mtime);
  const newest = present[0];
  return {
    fileName: newest.fileName,
    size: newest.size,
    // Non-null by construction: the name passed XLANT_INSTALLER_RE above.
    version: XLANT_INSTALLER_RE.exec(newest.fileName)![1],
  };
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

/** The updater's manifest filename, fixed by electron-updater's generic
 * provider. */
export const XLANT_UPDATE_MANIFEST = "latest.yml";

/**
 * The update feed's RELEASE gate, which is a different question from
 * `safeArtifactName()`'s traversal gate and must not be confused with it. A
 * name can be perfectly safe and still be something this feed has no business
 * publishing: `latest.yml.part` is the publish step's half-written temp file
 * (electron-updater reading one would parse a truncated manifest), and
 * anything else an operator leaves in the directory — a note, a signing log, a
 * pruned build's leftovers — is not a release artifact either.
 *
 * Exactly three shapes are served, all derived from the SAME installer regex
 * the staff download uses, so a filename convention can only change in one
 * place:
 *
 *   · `latest.yml`                        — the manifest;
 *   · `XLAnt-Setup-<version>.exe`         — the installer;
 *   · `XLAnt-Setup-<version>.exe.blockmap` — its blockmap.
 *
 * Anything else is 404, and the route applies this AFTER the device-token
 * check so the feed never becomes a directory oracle for an anonymous caller.
 */
export function isXlantUpdateArtifact(name: string): boolean {
  if (name === XLANT_UPDATE_MANIFEST) return true;
  if (XLANT_INSTALLER_RE.test(name)) return true;
  const suffix = ".blockmap";
  return (
    name.endsWith(suffix) &&
    XLANT_INSTALLER_RE.test(name.slice(0, -suffix.length))
  );
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
