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
// TWO ORIGINS, BOTH REAL. XLAnt's relay and its installer artifacts are shared
// by two hosts, not owned by one:
//
//   · THE RELAY (`xlant-relay` on 135.232.204.158:8403) accepts BOTH VMs. Two
//     NSG /32 rules open TCP 8403 to it — `AllowXLAntRelayFromRoleplay`
//     (priority 221, 157.55.165.83/32, xl-roleplay-web) and
//     `AllowXLAntRelayFromAiWebsite` (52.237.160.75/32, this host) — and every
//     request still needs the X-XLAnt-Proxy-Secret header regardless of source.
//   · THE ARTIFACTS are published to BOTH hosts by the xlant repo's own
//     publish step (docs/SETUP.md §4), which writes each file as `<name>.part`
//     and renames it, exe + blockmap first and `latest.yml` last. So
//     /opt/xlant-artifacts on THIS VM really holds the installers (0.2.0 as of
//     2026-09-04), and latestInstaller() reads them locally — it never proxies
//     to roleplay.
//
// WHAT THIS HOST OWNS, AND WHAT IT DOES NOT. ai.xl.net is XLAnt's HUMAN-facing
// home: the staff-gated page at /internal/xlant, the installer download, and
// the per-user device-token mint. It is NOT the DEVICE lane. XLAnt desktops
// keep talking to roleplay.xl.net for the authenticated relay passthrough
// (/api/xlant/relay/*) and the electron-updater feed (/api/xlant/update/*),
// because that is the origin the shipped installers are pinned to. Do not move
// those here without re-signing and re-publishing the desktop.
//
// ARMING GATE. All three env vars must be present (XLANT_RELAY_URL,
// XLANT_PROXY_SHARED_SECRET ≥16 chars, XLANT_ARTIFACTS_DIR) or xlantConfig()
// returns null and every XLAnt surface answers 503. Half-configured is not a
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
 * the only credential the relay accepts; the NSG rules above decide who may
 * reach port 8403 at all, and this host is one of the two that may. */
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
const INSTALLER_RE = /^XLAnt-Setup-(\d+\.\d+\.\d+(?:-[\w.]+)?)\.exe$/;

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
    (n) => !n.endsWith(".part") && INSTALLER_RE.test(n)
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
    // Non-null by construction: the name passed INSTALLER_RE above.
    version: INSTALLER_RE.exec(newest.fileName)![1],
  };
}

/**
 * Serve a file from the artifacts dir, refusing traversal and odd names. The
 * name the download route uses comes from readdir(), not from a request, so
 * this is defence in depth — and it is what keeps that true if a future route
 * ever accepts a name.
 */
export function safeArtifactName(name: string): boolean {
  return /^[\w][\w.-]*$/.test(name) && !name.includes("..");
}
