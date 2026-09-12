#!/usr/bin/env -S npx tsx
// Invariant checks for the XLAnt DEVICE lane (ARCHITECTURE.md §5.22). Plain
// node:assert, no framework (the host repo has none) and NO DATABASE. Run:
//
//   npm run test:xlant
//
// TWO HALVES. Sections 1-7 are pure: the allowlist, the artifact predicates, the
// platform enums and the verify cache, exercised as functions. Sections 8-10
// EXECUTE THE REAL ROUTE
// HANDLERS AND THE REAL MIDDLEWARE in-process against a fake XLAnt relay on
// 127.0.0.1 and a scratch artifacts directory, because the pure half cannot see
// what the handlers actually put on the wire — which headers reach the relay,
// which caller-supplied headers do NOT, what a caller gets back when the relay
// is down. (A first cut of this file asserted the CSRF exclusion by grepping
// `src/proxy.ts` for quoted prefixes; that regex would miss a prefix added
// inline, so the middleware is now run instead.) No network leaves the box: the
// only server is one this file starts and stops.
//
// What is pinned:
//
//   · ONE TOKEN PER COMPUTER (2026-09-08) — the two new staff routes
//     `GET /api/internal/xlant/devices` and
//     `POST /api/internal/xlant/devices/revoke`, executed in-process against a
//     REAL SIGNED SESSION (see section 8b for how the request scope is faked
//     and why that is worth doing): who is refused, that the relay is told the
//     SESSION's email and never a body's, that an unreadable list is a 502 and
//     never an empty one, and that a bad device id never leaves this host;
//     plus the internal `v1/device/list` and `v1/device/revoke` on the
//     REJECTION side of the allowlist, where every internal route belongs;
//   · the relay ALLOWLIST — the exact eight shapes and nothing else. That list
//     is a MIRROR of the route list in the xlant repo's
//     packages/shared/src/contract.ts, and the relay mirrors it a third time;
//     if a change to the contract does not appear here, the two sides have
//     drifted and the passthrough is either broken or too wide. The rejection
//     legs are the ones that matter: `v1/device/issue` and `v1/device/verify`
//     are the INTERNAL routes that mint and check device tokens, and a prefix
//     match or an unanchored test would publish them to the internet.
//   · which allowlisted path is the MCP one (the only body that may arrive
//     with no declared length);
//   · `safeArtifactName()` (the traversal gate) and `isXlantUpdateArtifact()`
//     (the RELEASE gate), which are different questions and are both needed:
//     `latest.yml.part` is a safe name and a truncated manifest;
//   · the MAC half of contract 0.5.0 — the two device kinds, the two Mac
//     architectures, the `XLAnt-<version>-<arm64|x64>-mac.zip` filename
//     contract (and the arch-less `XLAnt-<version>-mac.zip` that a build which
//     lost its explicit `artifactName` would emit, refused on purpose), the
//     download route's query-string decision, the Content-Type table, and the
//     pre-mint `/v1/status` probe that keeps a pre-0.5.0 relay from being
//     reported as "the relay refused the token mint";
//   · `verifyDeviceToken()`'s cache — positives cached, negatives and relay
//     failures NOT cached, oldest-half eviction past the cap, a too-short
//     token refused without a relay round-trip;
//   · and, live: forwarded vs withheld headers, the body caps, query-string
//     preservation, upstream status pass-through, 502/504 when the relay is
//     down or slow, the arming gate, and that the CSRF middleware lets an
//     Origin-less device POST through while still refusing one to
//     `/api/internal/xlant`.
//
// NO REAL TOKENS. Every token here is a synthetic filler string; a real device
// token reaches a technician agent on somebody's PC and git history would keep
// it after any revert.

// FIRST, AND IT HAS TO BE FIRST. Next's request-scope storage
// (`work-unit-async-storage`) decides ONCE, when its module is first loaded,
// whether a real AsyncLocalStorage exists: it reads `globalThis.AsyncLocalStorage`,
// which Node does not define, and falls back to a stub whose `.run()` throws
// and whose `.getStore()` is always undefined. Section 8b needs a real one, and
// the very next import below (`../src/lib/xlant`) pulls that module in through
// @aicompany/core/auth/session -> next/headers. ES modules evaluate in source
// order and a statement cannot run before an import, so the only place left to
// set the global is a module that is itself imported earlier — hence this
// one-line data: module. (No `?` anywhere in it: a question mark in a data URL
// starts the query string and would truncate the source.) Nothing about the
// PRODUCT depends on this; it is how a route handler that calls `headers()`
// can be executed at all outside `next start`.
import "data:text/javascript,import{AsyncLocalStorage}from'node:async_hooks';globalThis.AsyncLocalStorage=AsyncLocalStorage;";

import assert from "node:assert";
import { execFileSync } from "node:child_process";
import http from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  XLANT_DEVICE_KINDS,
  XLANT_INSTALLER_RE,
  XLANT_MAC_ARCHES,
  XLANT_MAC_BUNDLE_RE,
  XLANT_MCP_PATH,
  XLANT_RELAY_ALLOWED,
  isXlantDeviceId,
  isXlantDeviceKind,
  isXlantMacArch,
  isXlantMcpPath,
  isXlantRelayPath,
  isXlantUpdateArtifact,
  latestInstaller,
  latestMacBundle,
  probeRelayMacSupport,
  resetXlantVerifyCache,
  safeArtifactName,
  verifyDeviceToken,
  xlantArtifactContentType,
  xlantDeviceSummaries,
  xlantDownloadRequest,
  xlantVerifyCacheSize,
  type XlantConfig,
} from "../src/lib/xlant";

let failures = 0;
async function leg(label: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`ok   ${label}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${label}\n     ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// 1. The relay allowlist — exactly eight shapes
// ---------------------------------------------------------------------------

await leg("the allowlist holds exactly the eight contract shapes", () => {
  assert.equal(XLANT_RELAY_ALLOWED.length, 8);
  for (const re of XLANT_RELAY_ALLOWED) {
    // Anchored at BOTH ends: an unanchored entry matches any longer path that
    // merely contains an allowed one.
    assert.ok(re.source.startsWith("^"), `not ^-anchored: ${re.source}`);
    assert.ok(re.source.endsWith("$"), `not $-anchored: ${re.source}`);
    // A /g regex is stateful across .test() calls, so the predicate would
    // answer differently on identical input.
    assert.equal(re.flags, "", `unexpected flags on ${re.source}`);
  }
});

const ACCEPTED = [
  "v1/device/hello",
  "v1/device/credits",
  "v1/device/restore-grant",
  "v1/incident/start",
  "v1/incident/inc_123/events",
  "v1/incident/inc_123/decision",
  "v1/incident/inc_123/chat",
  "v1/incident/inc_123/close",
  "v1/incident/inc-123/tools/next",
  "v1/incident/inc_123/tools/call-7/result",
  "v1/mcp/bridge_token_abc-123",
];

await leg("every device and MCP surface the contract names is accepted", () => {
  for (const rel of ACCEPTED) {
    assert.ok(isXlantRelayPath(rel), `should accept ${rel}`);
  }
});

const REJECTED = [
  // Prefix / suffix variants of an allowed path.
  "v1/device/hello/x",
  "v1/device/hello/",
  "xv1/device/hello",
  "v1/device/credits/x",
  "v1/device/credits/",
  "v1/device/creditsx",
  "v1/device/credit",
  "v1/device/restore-grant/x",
  "v1/device/restore-grant/",
  "v1/device/restore-grantx",
  "v1/device/restore",
  "v1/incident/start/x",
  "v1/incident/inc_123/events/x",
  "v1/incident/inc_123/tools/next/x",
  "v1/incident/inc_123/tools/call-7/result/extra",
  "v1/mcp/tok/x",
  // Traversal, in the shapes a catch-all can produce.
  "v1/incident/../x",
  "v1/incident/../../v1/device/issue",
  "v1/mcp/../device/issue",
  "../v1/device/hello",
  "v1/incident/%2e%2e/events",
  // Empty and bare segments.
  "",
  "v1/mcp/",
  "v1/mcp",
  "v1/incident//events",
  "v1/incident/inc_123/tools//result",
  // INTERNAL relay routes — this origin must never publish these.
  "v1/status",
  "v1/device/issue",
  "v1/device/verify",
  "v1/providers/refresh",
  // The 2026-09-08 pair, and they are internal for the same reason `issue` is:
  // both take an `email` in the request rather than a device token, so a
  // published `list` would enumerate anybody's machines by address and a
  // published `revoke` would take them off the air. This host reaches them
  // server-side only, from the staff routes, with the shared secret.
  "v1/device/list",
  "v1/device/revoke",
  "v1/device/list/",
  "v1/device/lists",
  "v1/device/revoke/x",
  // Near misses.
  "v1/device/hell",
  "v1/incident/inc_123/decisions",
  "v1/incident/inc_123/tools/next?wait=25",
  "v2/device/hello",
];

await leg("everything else is refused, traversal and internals included", () => {
  for (const rel of REJECTED) {
    assert.ok(!isXlantRelayPath(rel), `should reject ${JSON.stringify(rel)}`);
  }
});

await leg("the accept and reject lists do not overlap", () => {
  for (const rel of REJECTED) assert.ok(!ACCEPTED.includes(rel));
});

await leg("no URL metacharacter survives the allowlist", () => {
  // The allowlisted `rel` is concatenated into the upstream URL, so a
  // character that could open a query, a fragment, an authority or a second
  // path segment must never pass the id classes.
  const leaked: string[] = [];
  for (const ch of '?#%\\@:. \t\r\n<>"\'') {
    for (const cand of [
      `v1/mcp/a${ch}b`,
      `v1/incident/i${ch}d/events`,
      `v1/device/hello${ch}`,
      `v1/incident/i/tools/c${ch}1/result`,
    ]) {
      if (isXlantRelayPath(cand)) leaked.push(JSON.stringify(cand));
    }
  }
  assert.deepEqual(leaked, []);
});

// ---------------------------------------------------------------------------
// 2. MCP path detection — the one allowlisted path that is not a device route
// ---------------------------------------------------------------------------

await leg("only v1/mcp/{bridgeToken} is the MCP path", () => {
  assert.ok(isXlantMcpPath("v1/mcp/bridge_token_abc-123"));
  assert.ok(XLANT_MCP_PATH.test("v1/mcp/t0"));
  for (const rel of ACCEPTED) {
    if (rel.startsWith("v1/mcp/")) continue;
    assert.ok(!isXlantMcpPath(rel), `${rel} is not the MCP path`);
  }
  // Nothing the allowlist already refused is an MCP path either, so the
  // length-less-body concession cannot be reached around the allowlist.
  for (const rel of REJECTED) {
    assert.ok(!isXlantMcpPath(rel), `${rel} is not the MCP path`);
  }
});

await leg("the MCP shape is one of the allowlisted eight", () => {
  assert.ok(
    XLANT_RELAY_ALLOWED.some((re) => re.source === XLANT_MCP_PATH.source),
    "XLANT_MCP_PATH must be one of XLANT_RELAY_ALLOWED"
  );
});

// ---------------------------------------------------------------------------
// 3. safeArtifactName — the update feed's traversal gate
// ---------------------------------------------------------------------------

await leg("every name electron-updater actually asks for passes", () => {
  for (const n of [
    // Windows.
    "latest.yml",
    "XLAnt-Setup-0.2.1.exe",
    "XLAnt-Setup-0.2.1.exe.blockmap",
    // macOS (contract 0.5.0). The traversal gate must not be what refuses
    // these, or the release gate below would never get a say.
    "latest-mac.yml",
    "XLAnt-0.5.0-arm64-mac.zip",
    "XLAnt-0.5.0-arm64-mac.zip.blockmap",
    "XLAnt-0.5.0-x64-mac.zip",
    "XLAnt-0.5.0-x64-mac.zip.blockmap",
  ]) {
    assert.ok(safeArtifactName(n), `should accept ${n}`);
  }
});

await leg("traversal, absolute paths and odd names are refused", () => {
  for (const n of [
    "",
    ".",
    "..",
    "../.env",
    "../../etc/passwd",
    "a/../b",
    "sub/latest.yml",
    "/etc/passwd",
    ".env",
    "-rf",
    "latest.yml .txt",
    "latest yml",
    "XLAnt Setup.exe",
  ]) {
    assert.ok(!safeArtifactName(n), `should refuse ${JSON.stringify(n)}`);
  }
});

// ---------------------------------------------------------------------------
// 4. isXlantUpdateArtifact — the RELEASE gate, a different question
// ---------------------------------------------------------------------------

await leg("exactly the manifest, an installer and its blockmap are releases", () => {
  for (const n of [
    "latest.yml",
    "XLAnt-Setup-0.2.1.exe",
    "XLAnt-Setup-0.2.1.exe.blockmap",
    "XLAnt-Setup-1.10.0-beta.3.exe",
    "XLAnt-Setup-1.10.0-beta.3.exe.blockmap",
  ]) {
    assert.ok(isXlantUpdateArtifact(n), `should publish ${n}`);
  }
});

await leg("the macOS manifest, both bundles and their blockmaps are releases", () => {
  // The names electron-builder actually wrote on the build box, 2026-09-05:
  // `--mac zip --arm64` produced XLAnt-0.4.2-arm64-mac.zip, its .blockmap and
  // latest-mac.yml. The x64 twin is the same pattern with the other arch.
  for (const n of [
    "latest-mac.yml",
    "XLAnt-0.5.0-arm64-mac.zip",
    "XLAnt-0.5.0-arm64-mac.zip.blockmap",
    "XLAnt-0.5.0-x64-mac.zip",
    "XLAnt-0.5.0-x64-mac.zip.blockmap",
    "XLAnt-0.4.2-arm64-mac.zip",
    "XLAnt-1.10.0-beta.3-x64-mac.zip",
    "XLAnt-1.10.0-beta.3-x64-mac.zip.blockmap",
  ]) {
    assert.ok(isXlantUpdateArtifact(n), `should publish ${n}`);
  }
  // The Windows manifest is NOT the Mac one and vice versa: a macOS client
  // asks for latest-mac.yml and nothing else, so neither name may drift into
  // meaning both.
  assert.notEqual("latest.yml", "latest-mac.yml");
});

await leg("no Mac name outside the two-arch zip contract is a release", () => {
  for (const n of [
    // The publish step's half-written temp files, the reason the release gate
    // exists at all: served, latest-mac.yml.part hands electron-updater a
    // truncated manifest.
    "latest-mac.yml.part",
    "XLAnt-0.5.0-arm64-mac.zip.part",
    "XLAnt-0.5.0-arm64-mac.zip.blockmap.part",
    // A build whose explicit `mac.artifactName` was lost: electron-builder's
    // default drops "-${arch}" for its DEFAULT arch, which is x64, so the
    // Intel zip arrives with no architecture in its name. Refused, because
    // serving an unlabelled bundle to whoever clicked "Intel" is a guess.
    "XLAnt-0.5.0-mac.zip",
    "XLAnt-0.5.0-mac.zip.blockmap",
    // A universal bundle: the desktop builds two zips, not three.
    "XLAnt-0.5.0-universal-mac.zip",
    "XLAnt-0.5.0-universal-mac.zip.blockmap",
    // Other targets nobody publishes here.
    "XLAnt-0.5.0-mac.dmg",
    "XLAnt-0.5.0-arm64-mac.dmg",
    "XLAnt-0.5.0-arm64-mac.pkg",
    "XLAnt-0.5.0-arm64-mac.zip.blockmap.blockmap",
    // Architecture spellings that are not ours.
    "XLAnt-0.5.0-aarch64-mac.zip",
    "XLAnt-0.5.0-x86_64-mac.zip",
    "XLAnt-0.5.0-ARM64-mac.zip",
    // Version shapes the strict group refuses, same reason as the installer's.
    "XLAnt-x-arm64-mac.zip",
    "XLAnt-0.5-arm64-mac.zip",
    "XLAnt-0.5.0.1-arm64-mac.zip",
    // The Windows prefix on a Mac bundle, and a prefixed name.
    "XLAnt-Setup-0.5.0-arm64-mac.zip",
    "prefix-XLAnt-0.5.0-arm64-mac.zip",
    // Manifest near-misses.
    "latest-mac.yaml",
    "latest-mac.yml.bak",
    "latest-linux.yml",
  ]) {
    assert.ok(!isXlantUpdateArtifact(n), `should NOT publish ${n}`);
  }
});

await leg("a safe name is not automatically a publishable one", () => {
  for (const n of [
    // The publish step's half-written temp files. `latest.yml.part` is the one
    // that matters: served, it hands electron-updater a truncated manifest.
    "latest.yml.part",
    "XLAnt-Setup-0.2.1.exe.part",
    "XLAnt-Setup-0.2.1.exe.blockmap.part",
    // Anything else an operator may leave in the directory.
    "notes.txt",
    "latest.yml.bak",
    "XLAnt-Setup-x.exe.exe",
    "XLAnt-Setup-1.2.exe",
    "XLAnt-Setup-0.2.1.exe.blockmap.blockmap",
    "blockmap",
    ".blockmap",
    "signing.log",
  ]) {
    assert.ok(safeArtifactName(n) || n.startsWith("."), `precondition: ${n}`);
    assert.ok(!isXlantUpdateArtifact(n), `should NOT publish ${n}`);
  }
});

// ---------------------------------------------------------------------------
// 5. The two filename regexes
// ---------------------------------------------------------------------------

await leg("the installer regex captures a real version and nothing else", () => {
  assert.equal(XLANT_INSTALLER_RE.exec("XLAnt-Setup-0.2.1.exe")?.[1], "0.2.1");
  assert.equal(
    XLANT_INSTALLER_RE.exec("XLAnt-Setup-1.10.0-beta.3.exe")?.[1],
    "1.10.0-beta.3"
  );
  for (const n of [
    // The defect the strict pattern exists for: a loose [\w.-]+ accepts this
    // and would then show "x.exe" to staff as the version being downloaded.
    "XLAnt-Setup-x.exe.exe",
    "XLAnt-Setup-.exe",
    "XLAnt-Setup-1.2.exe",
    "XLAnt-Setup-1.2.3.4.exe",
    "XLAnt-Setup-0.2.1.exe.blockmap",
    "XLAnt-Setup-0.2.1.exe.part",
    "xlant-setup-0.2.1.exe",
    "latest.yml",
    "prefix-XLAnt-Setup-0.2.1.exe",
  ]) {
    assert.ok(!XLANT_INSTALLER_RE.test(n), `should refuse ${n}`);
  }
});

await leg("the Mac bundle regex captures a real version AND the architecture", () => {
  const arm = XLANT_MAC_BUNDLE_RE.exec("XLAnt-0.5.0-arm64-mac.zip");
  assert.equal(arm?.[1], "0.5.0");
  assert.equal(arm?.[2], "arm64");
  const intel = XLANT_MAC_BUNDLE_RE.exec("XLAnt-1.10.0-beta.3-x64-mac.zip");
  assert.equal(intel?.[1], "1.10.0-beta.3");
  assert.equal(intel?.[2], "x64");
  // Both regexes are anchored and flag-free for the same reasons the allowlist
  // is: an unanchored pattern matches a longer name that merely contains one,
  // and a /g regex answers differently on identical input.
  for (const re of [XLANT_INSTALLER_RE, XLANT_MAC_BUNDLE_RE]) {
    assert.ok(re.source.startsWith("^"), `not ^-anchored: ${re.source}`);
    assert.ok(re.source.endsWith("$"), `not $-anchored: ${re.source}`);
    assert.equal(re.flags, "", `unexpected flags on ${re.source}`);
  }
  // The two never claim the same file, so "is this a Windows or a Mac build?"
  // has exactly one answer for every name.
  for (const n of [
    "XLAnt-Setup-0.5.0.exe",
    "XLAnt-0.5.0-arm64-mac.zip",
    "XLAnt-0.5.0-x64-mac.zip",
  ]) {
    assert.notEqual(
      XLANT_INSTALLER_RE.test(n),
      XLANT_MAC_BUNDLE_RE.test(n),
      `${n} matched both or neither filename contract`
    );
  }
});

// ---------------------------------------------------------------------------
// 6. Contract 0.5.0's platform words: the kinds, the architectures, what the
//    download route decides from a query string, and the Content-Type table
// ---------------------------------------------------------------------------

await leg("the device kinds are exactly the contract's two", () => {
  // A MIRROR of DEVICE_KINDS in the xlant repo's packages/shared/src/contract.ts
  // (the two repos share no code). The kind decides which BUILD a token is for
  // — it stopped being a count on 2026-09-08, when a person became able to
  // hold one token per computer — so a third entry here that the relay does not
  // know would mint nothing at all.
  assert.deepEqual([...XLANT_DEVICE_KINDS], ["windows", "mac"]);
  for (const k of ["windows", "mac"]) {
    assert.ok(isXlantDeviceKind(k), `should accept ${k}`);
  }
  for (const k of [
    "Windows",
    "MAC",
    "macos",
    "darwin",
    "linux",
    "ios",
    "windows ",
    "",
    null,
    undefined,
    7,
    ["mac"],
  ]) {
    assert.ok(!isXlantDeviceKind(k), `should refuse ${JSON.stringify(k)}`);
  }
});

await leg("the Mac architectures are exactly arm64 and x64", () => {
  assert.deepEqual([...XLANT_MAC_ARCHES], ["arm64", "x64"]);
  assert.ok(isXlantMacArch("arm64"));
  assert.ok(isXlantMacArch("x64"));
  for (const a of [
    // Spellings other toolchains use. None of them names a file this host
    // publishes, and admitting one would 404 a staffer at the download.
    "aarch64",
    "amd64",
    "x86_64",
    "ARM64",
    "x64 ",
    // The bundle the desktop deliberately does not build.
    "universal",
    "",
    null,
    undefined,
    64,
  ]) {
    assert.ok(!isXlantMacArch(a), `should refuse ${JSON.stringify(a)}`);
  }
});

await leg("the download route's query string decides one build, or refuses", () => {
  const ask = (qs: string) => xlantDownloadRequest(new URLSearchParams(qs));
  // No query at all is the WINDOWS installer — the link this host has served
  // since the page existed, and the one an old bookmark still carries.
  assert.deepEqual(ask(""), { ok: true, platform: "windows" });
  assert.deepEqual(ask("platform=windows"), { ok: true, platform: "windows" });
  // `arch` is meaningless for Windows and is IGNORED, not refused: there is one
  // Windows build and a stray parameter must not break a working link.
  assert.deepEqual(ask("platform=windows&arch=arm64"), {
    ok: true,
    platform: "windows",
  });
  assert.deepEqual(ask("platform=mac&arch=arm64"), {
    ok: true,
    platform: "mac",
    arch: "arm64",
  });
  assert.deepEqual(ask("platform=mac&arch=x64"), {
    ok: true,
    platform: "mac",
    arch: "x64",
  });
  // A Mac ask with no architecture is refused rather than defaulted: the two
  // zips are not interchangeable, and an arm64 bundle on an Intel Mac does not
  // launch.
  for (const qs of [
    "platform=mac",
    "platform=mac&arch=",
    "platform=mac&arch=universal",
    "platform=mac&arch=x86_64",
    "platform=mac&arch=ARM64",
  ]) {
    const got = ask(qs);
    assert.deepEqual(got, { ok: false, error: "arch must be 'arm64' or 'x64'" }, qs);
  }
  for (const qs of [
    "platform=",
    "platform=Mac",
    "platform=macos",
    "platform=linux",
    "platform=darwin&arch=arm64",
  ]) {
    assert.deepEqual(
      ask(qs),
      { ok: false, error: "platform must be 'windows' or 'mac'" },
      qs
    );
  }
});

await leg("every publishable name has one Content-Type and no sniffing", () => {
  for (const [name, want] of [
    ["latest.yml", "text/yaml"],
    ["latest-mac.yml", "text/yaml"],
    ["XLAnt-Setup-0.5.0.exe", "application/octet-stream"],
    ["XLAnt-Setup-0.5.0.exe.blockmap", "application/octet-stream"],
    ["XLAnt-0.5.0-arm64-mac.zip", "application/zip"],
    ["XLAnt-0.5.0-x64-mac.zip", "application/zip"],
    // The blockmap of a zip is a BLOCKMAP, not a zip: it ends in .blockmap, so
    // the .zip test (an endsWith on the whole name) must not claim it.
    ["XLAnt-0.5.0-arm64-mac.zip.blockmap", "application/octet-stream"],
    ["XLAnt-0.5.0-x64-mac.zip.blockmap", "application/octet-stream"],
  ] as const) {
    assert.equal(xlantArtifactContentType(name), want, name);
  }
  // Every name the release gate publishes gets a type from this table, so the
  // feed can never answer with an empty or invented content type.
  for (const n of [
    "latest.yml",
    "latest-mac.yml",
    "XLAnt-Setup-9.9.9.exe",
    "XLAnt-Setup-9.9.9.exe.blockmap",
    "XLAnt-9.9.9-arm64-mac.zip",
    "XLAnt-9.9.9-arm64-mac.zip.blockmap",
    "XLAnt-9.9.9-x64-mac.zip",
    "XLAnt-9.9.9-x64-mac.zip.blockmap",
  ]) {
    assert.ok(isXlantUpdateArtifact(n), `precondition: ${n}`);
    assert.match(xlantArtifactContentType(n), /^[a-z]+\/[\w.+-]+$/, n);
  }
});

// ---------------------------------------------------------------------------
// 6b. The computer list (2026-09-08): the shape this host hands the browser,
//     the id it will forward, and the words the island prints
// ---------------------------------------------------------------------------

await leg("a device id is this product's own opaque id class and nothing else", () => {
  // `_` is IN, matching `[\w-]` in the allowlist above: incident ids, tool
  // call ids and bridge tokens are all `[A-Za-z0-9_-]` here, so a class that
  // omitted the underscore would refuse a Sign out on ids the relay issues.
  for (const good of ["dev_1", "dev-1", "DEV_abc-123", "a", "a".repeat(80)]) {
    assert.ok(isXlantDeviceId(good), `should accept ${good}`);
  }
  // Everything that could mean something somewhere else. These never reach the
  // internal lane inside a JSON field, which is the point of testing at all:
  // the body is not a URL, but the relay's handler puts the value into a query.
  for (const bad of [
    "",
    " ",
    "a".repeat(81),
    "dev 1",
    "dev/1",
    "dev.1",
    "dev?1",
    "dev&1",
    "dev#1",
    "dev%2f1",
    "..",
    "dev\n1",
    7,
    null,
    undefined,
    {},
    ["dev_1"],
  ]) {
    assert.ok(!isXlantDeviceId(bad), `should reject ${JSON.stringify(bad)}`);
  }
});

await leg("the device list is re-read, not relayed: bad rows drop, blanks are null", () => {
  // NOT an array is null, and null is what the route turns into a 502. The
  // distinction is load-bearing: "you have no computers" is a sentence the
  // page prints, and a person with two laptops must never read it because the
  // relay answered something unreadable.
  for (const notAList of [undefined, null, {}, "[]", 7, { devices: [] }]) {
    assert.equal(xlantDeviceSummaries(notAList), null, JSON.stringify(notAList));
  }
  assert.deepEqual(xlantDeviceSummaries([]), []);

  // A whole row survives verbatim — this host adds nothing and renames nothing.
  const whole = {
    deviceId: "dev_one",
    kind: "windows" as const,
    machineName: "XL-LPT-A1",
    userName: "adam",
    clientVersion: "0.11.2",
    createdAt: "2026-09-04T10:00:00.000Z",
    lastSeenAt: "2026-09-08T11:00:00.000Z",
    expiresAt: null,
    openIncidents: 2,
  };
  assert.deepEqual(xlantDeviceSummaries([whole]), [whole]);

  // A row with no usable id is DROPPED rather than drawn: the id is what the
  // Sign out button posts back, so a row without one is a button that cannot
  // work and a promise the page cannot keep.
  assert.deepEqual(xlantDeviceSummaries([{ kind: "mac" }, { deviceId: "  " }]), []);
  // A local unwrapper rather than a `!`: every call below is expected to
  // produce a list, and a null here should fail as a null, not as a TypeError.
  const rowsOf = (v: unknown) => {
    const r = xlantDeviceSummaries(v);
    assert.ok(r, "expected a list of computers");
    return r;
  };
  assert.deepEqual(
    rowsOf([{ deviceId: "keep" }, { deviceId: 7 }, null, "x", ["y"]]).map(
      (r) => r.deviceId
    ),
    ["keep"]
  );

  // An unrecognised kind is null, never "windows": guessing Windows for a Mac
  // is worse than the page saying "Computer".
  const odd = rowsOf([
    { deviceId: "d", kind: "linux", machineName: "", clientVersion: "", openIncidents: -3 },
  ]);
  assert.equal(odd[0].kind, null);
  // An empty string is a null, so the island prints its own words ("not
  // connected yet", "—") rather than an empty cell.
  assert.equal(odd[0].machineName, null);
  assert.equal(odd[0].clientVersion, null);
  assert.equal(odd[0].userName, null);
  assert.equal(odd[0].lastSeenAt, null);
  assert.equal(odd[0].createdAt, "");
  // "N open" is drawn only above zero, so a negative or fractional count is 0.
  assert.equal(odd[0].openIncidents, 0);
  assert.equal(rowsOf([{ deviceId: "d", openIncidents: 2.9 }])[0].openIncidents, 2);
  assert.equal(rowsOf([{ deviceId: "d", openIncidents: "3" }])[0].openIncidents, 0);

  // `expiresAt` is the one field held to a stricter standard than "a non-empty
  // string", because it is the only one drawn as a COUNTDOWN: a value that is
  // not an instant would become a fabricated number of days on a staff page.
  const expiring = "2026-09-15T11:30:00.000Z";
  assert.equal(rowsOf([{ deviceId: "d", expiresAt: expiring }])[0].expiresAt, expiring);
  for (const bad of [undefined, null, "", "   ", "next Tuesday", "soon", 7, {}, ["x"]]) {
    assert.equal(
      rowsOf([{ deviceId: "d", expiresAt: bad }])[0].expiresAt,
      null,
      JSON.stringify(bad)
    );
  }
});

await leg("the island says how long ago in words, and never invents one", async () => {
  // The island is imported for its two pure helpers only. It is a "use client"
  // file, so this also proves it can be evaluated without a server module —
  // an accidental `@/lib/xlant` import there would drag node:fs and the shared
  // secret into a browser bundle (pinned again as a source leg in section 10).
  const island = await import("../src/app/internal/xlant/devices-list");
  const now = Date.parse("2026-09-08T12:00:00.000Z");
  const at = (iso: string) => island.lastSeenWords(iso, now);

  assert.equal(island.lastSeenWords(null), "never");
  assert.equal(island.lastSeenWords("whenever"), "unknown", "no invented duration");
  assert.equal(at("2026-09-08T11:59:31.000Z"), "just now");
  // A relay clock AHEAD of the viewer's must not read "in a moment".
  assert.equal(at("2026-09-08T12:05:00.000Z"), "just now");
  assert.equal(at("2026-09-08T11:59:00.000Z"), "1 minute ago");
  assert.equal(at("2026-09-08T11:58:00.000Z"), "2 minutes ago");
  assert.equal(at("2026-09-08T11:00:00.000Z"), "1 hour ago");
  assert.equal(at("2026-09-08T10:00:00.000Z"), "2 hours ago");
  assert.equal(at("2026-09-07T12:00:00.000Z"), "1 day ago");
  assert.equal(at("2026-09-01T12:00:00.000Z"), "7 days ago");

  // THE SIGN-OUT CONFIRM, both shapes (refuter R2, F10). Signing a computer
  // out closes every non-terminal piece of work of that device on the relay,
  // and the row is already showing "N open" a few pixels away — a confirm that
  // stayed silent about it would be asking the person to agree to something
  // the page had already told them was there.
  assert.equal(
    island.confirmWords("XL-LPT-A1", 0),
    "Sign XL-LPT-A1 out of XLAnt? Its token stops working immediately, and that computer needs a new one from this page to come back."
  );
  assert.equal(
    island.confirmWords("XL-LPT-A1", 1),
    "Sign XL-LPT-A1 out of XLAnt? Its token stops working immediately, and that computer needs a new one from this page to come back. The one piece of work XLAnt still has open on it ends with it."
  );
  assert.equal(
    island.confirmWords("XL-LPT-A1", 2),
    "Sign XL-LPT-A1 out of XLAnt? Its token stops working immediately, and that computer needs a new one from this page to come back. The 2 pieces of work XLAnt still has open on it end with it."
  );
  // A count that never happens must still not produce a clause about it.
  assert.equal(island.confirmWords("x", -1), island.confirmWords("x", 0));
  // The nameless row is a pronoun, never "not connected yet", which would read
  // as a machine name inside the sentence.
  assert.match(island.confirmWords("this computer", 0), /^Sign this computer out of XLAnt\?/);

  assert.equal(island.kindWords("windows"), "Windows");
  assert.equal(island.kindWords("mac"), "Mac");
  assert.equal(island.kindWords(null), "Computer");

  // THE NAME SLOT HAS THREE ANSWERS, not two. The relay binds the machine name
  // at the computer's FIRST INCIDENT, so an install that has said hello and
  // had nothing go wrong yet is connected, working and still nameless —
  // calling that "not connected yet" would tell a staffer their working PC
  // never arrived and invite them to mint another token for it.
  assert.equal(island.machineWords("XL-LPT-A1", null), "XL-LPT-A1");
  assert.equal(island.machineWords("XL-LPT-A1", "2026-09-08T11:00:00.000Z"), "XL-LPT-A1");
  assert.equal(island.machineWords(null, null), "not connected yet");
  assert.equal(
    island.machineWords(null, "2026-09-08T11:00:00.000Z"),
    "no name yet",
    "a computer that HAS reported must not read 'not connected yet'"
  );

  // The seven-day clock on a token nobody pasted anywhere. Days are FLOORED,
  // never rounded up: overstating the time somebody has left is the expensive
  // direction of that error.
  const until = (iso: string) => island.expiryWords(iso, now);
  assert.equal(island.expiryWords(null), null, "no clock, no sentence");
  assert.equal(island.expiryWords("whenever"), null, "no invented countdown");
  assert.equal(until("2026-09-15T12:00:00.000Z"), "expires in 7 days");
  assert.equal(until("2026-09-10T12:00:00.000Z"), "expires in 2 days");
  assert.equal(until("2026-09-10T11:00:00.000Z"), "expires in 1 day");
  // The day boundary, both sides: 23h59m left is "today", 24h00m is "1 day".
  assert.equal(until("2026-09-09T11:59:00.000Z"), "expires today");
  assert.equal(until("2026-09-09T12:00:00.000Z"), "expires in 1 day");
  assert.equal(until("2026-09-08T12:00:01.000Z"), "expires today");
  // Already past: the relay lists ACTIVE devices only, so this should never
  // arrive — and if it does, a positive countdown would be a lie.
  assert.equal(until("2026-09-08T12:00:00.000Z"), "expired");
  assert.equal(until("2026-09-01T12:00:00.000Z"), "expired");
});

// ---------------------------------------------------------------------------
// 7. verifyDeviceToken — the cache, against a stubbed global fetch
// ---------------------------------------------------------------------------

const cfg: XlantConfig = {
  relayUrl: "http://relay.invalid:8403",
  proxySecret: "x".repeat(32),
  artifactsDir: "/nonexistent-artifacts",
};

// Synthetic, and long enough to clear the pre-network length test.
const token = (n: number) =>
  `synthetic-device-token-${String(n).padStart(6, "0")}`;

const realFetch = globalThis.fetch;
let calls = 0;
type Mode = "ok" | "refuse" | "throw";
let mode: Mode = "ok";
globalThis.fetch = (async () => {
  calls++;
  if (mode === "throw") throw new Error("relay unreachable (stub)");
  return new Response(null, { status: mode === "ok" ? 200 : 401 });
}) as typeof fetch;

function fresh(m: Mode) {
  resetXlantVerifyCache();
  calls = 0;
  mode = m;
}

await leg("a too-short or empty token is refused with no relay call", async () => {
  fresh("ok");
  assert.equal(await verifyDeviceToken(cfg, ""), false);
  assert.equal(await verifyDeviceToken(cfg, "short"), false);
  assert.equal(await verifyDeviceToken(cfg, "a".repeat(19)), false);
  assert.equal(calls, 0, "no fetch may be made for a token of the wrong shape");
  assert.equal(xlantVerifyCacheSize(), 0);
  // 20 characters is the first accepted length, and it DOES reach the relay.
  assert.equal(await verifyDeviceToken(cfg, "a".repeat(20)), true);
  assert.equal(calls, 1);
});

await leg("a positive is cached: the second ask makes no relay call", async () => {
  fresh("ok");
  assert.equal(await verifyDeviceToken(cfg, token(1)), true);
  assert.equal(calls, 1);
  assert.equal(await verifyDeviceToken(cfg, token(1)), true);
  assert.equal(await verifyDeviceToken(cfg, token(1)), true);
  assert.equal(calls, 1, "a cached positive must not re-ask the relay");
  assert.equal(xlantVerifyCacheSize(), 1);
  // A DIFFERENT token is a different entry, never a hit on the first.
  assert.equal(await verifyDeviceToken(cfg, token(2)), true);
  assert.equal(calls, 2);
  assert.equal(xlantVerifyCacheSize(), 2);
});

await leg("a refusal is NOT cached: every ask re-asks the relay", async () => {
  fresh("refuse");
  assert.equal(await verifyDeviceToken(cfg, token(3)), false);
  assert.equal(await verifyDeviceToken(cfg, token(3)), false);
  assert.equal(calls, 2, "a negative must not be remembered");
  assert.equal(xlantVerifyCacheSize(), 0, "nothing is stored for a refusal");
});

await leg("a relay that throws is false, and is not remembered either", async () => {
  fresh("throw");
  assert.equal(await verifyDeviceToken(cfg, token(4)), false);
  assert.equal(xlantVerifyCacheSize(), 0);
  assert.equal(calls, 1);
  // The blip passes; the very next request must succeed rather than sit out
  // the TTL, which is the whole reason negatives are not cached.
  mode = "ok";
  assert.equal(await verifyDeviceToken(cfg, token(4)), true);
  assert.equal(calls, 2);
  assert.equal(xlantVerifyCacheSize(), 1);
});

await leg("past 500 entries the OLDEST HALF is evicted, not the map", async () => {
  fresh("ok");
  for (let i = 1; i <= 501; i++) await verifyDeviceToken(cfg, token(i));
  assert.equal(xlantVerifyCacheSize(), 501, "the cap is a > test, so 501 fits");
  // The 502nd insert trips it: 501 > 500, drop floor(501/2) = 250, then set.
  await verifyDeviceToken(cfg, token(502));
  assert.equal(xlantVerifyCacheSize(), 252);
  const after = calls;
  // The newest survivors are still cached, so they cost no relay call.
  assert.equal(await verifyDeviceToken(cfg, token(251)), true);
  assert.equal(await verifyDeviceToken(cfg, token(501)), true);
  assert.equal(await verifyDeviceToken(cfg, token(502)), true);
  assert.equal(calls, after, "entries past the eviction line must survive");
  // The oldest were dropped, so they cost a round-trip again — which is the
  // point: eviction must not sign every device out at once.
  assert.equal(await verifyDeviceToken(cfg, token(1)), true);
  assert.equal(calls, after + 1, "token 1 was evicted and must be re-verified");
});

globalThis.fetch = realFetch;
resetXlantVerifyCache();

// ===========================================================================
// 8. THE REAL HANDLERS, in-process, against a fake relay
// ===========================================================================

// A scratch artifacts directory plus a sibling holding a file that must never
// be served, so the traversal legs have a real target to fail to reach.
const ROOT = mkdtempSync(join(tmpdir(), "xlant-tests-"));
const ART = join(ROOT, "artifacts");
const OUTSIDE = join(ROOT, "outside");
mkdirSync(ART);
mkdirSync(OUTSIDE);
const YML = "version: 9.9.9\npath: XLAnt-Setup-9.9.9.exe\n";
writeFileSync(join(ART, "latest.yml"), YML);
writeFileSync(join(ART, "XLAnt-Setup-9.9.9.exe"), Buffer.alloc(4096, 7));
writeFileSync(join(ART, "XLAnt-Setup-9.9.9.exe.blockmap"), Buffer.alloc(64, 3));
writeFileSync(join(ART, "latest.yml.part"), "HALF WRITTEN\n");
writeFileSync(join(OUTSIDE, "secret.txt"), "SYNTHETIC-NEVER-SERVE\n");

// The macOS half of the same directory (contract 0.5.0). One manifest naming
// both architectures, one zip and one blockmap each, plus the shapes the
// release gate has to refuse while sitting in the SAME directory: the
// half-written temp file, a universal bundle nobody builds, and the arch-less
// name a build that lost its explicit `mac.artifactName` would produce.
const YML_MAC =
  "version: 9.9.9\nfiles:\n  - url: XLAnt-9.9.9-arm64-mac.zip\n  - url: XLAnt-9.9.9-x64-mac.zip\n";
writeFileSync(join(ART, "latest-mac.yml"), YML_MAC);
writeFileSync(join(ART, "XLAnt-9.9.9-arm64-mac.zip"), Buffer.alloc(8192, 11));
writeFileSync(join(ART, "XLAnt-9.9.9-arm64-mac.zip.blockmap"), Buffer.alloc(96, 5));
writeFileSync(join(ART, "XLAnt-9.9.9-x64-mac.zip"), Buffer.alloc(6144, 13));
writeFileSync(join(ART, "XLAnt-9.9.9-x64-mac.zip.blockmap"), Buffer.alloc(80, 6));
writeFileSync(join(ART, "latest-mac.yml.part"), "HALF WRITTEN\n");
writeFileSync(join(ART, "XLAnt-9.9.9-universal-mac.zip"), Buffer.alloc(32, 1));
writeFileSync(join(ART, "XLAnt-9.9.9-mac.zip"), Buffer.alloc(32, 2));
// A PREVIOUS arm64 release, kept the way the real directory keeps the previous
// build, and deliberately stamped NEWER than 9.9.9 so "newest by mtime" is
// measured rather than accidentally agreeing with "highest version".
writeFileSync(join(ART, "XLAnt-9.9.8-arm64-mac.zip"), Buffer.alloc(1024, 9));
const NEWER = Date.now() / 1000 + 60;
utimesSync(join(ART, "XLAnt-9.9.8-arm64-mac.zip"), NEWER, NEWER);

interface RelayCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}
let relayCalls: RelayCall[] = [];
let relayReply = {
  status: 200,
  body: '{"ok":true}',
  headers: {} as Record<string, string>,
};
const relay = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    relayCalls.push({
      method: req.method ?? "",
      url: req.url ?? "",
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, String(v)])
      ),
      body: Buffer.concat(chunks).toString(),
    });
    res.writeHead(relayReply.status, {
      "content-type": "application/json",
      ...relayReply.headers,
    });
    res.end(relayReply.body);
  });
});
await new Promise<void>((r) => relay.listen(0, "127.0.0.1", () => r()));
const RELAY_PORT = (relay.address() as AddressInfo).port;

const SECRET = "d".repeat(32);
process.env.SKIP_ENV_VALIDATION = "1";
process.env.INTERNAL_TRACK_SECRET ??= "synthetic-track-secret";
process.env.XLANT_RELAY_URL = `http://127.0.0.1:${RELAY_PORT}`;
process.env.XLANT_PROXY_SHARED_SECRET = SECRET;
process.env.XLANT_ARTIFACTS_DIR = ART;

// Imported AFTER the env is set. (They read it per request, but importing late
// keeps this file honest about the ordering the routes actually rely on.)
const relayRoute = await import("../src/app/api/xlant/relay/[[...path]]/route");
const updateRoute = await import("../src/app/api/xlant/update/[[...path]]/route");

const U = "https://ai.xl.net";
const ctx = (rel: string) => ({
  params: Promise.resolve({ path: rel === "" ? [] : rel.split("/") }),
});
function relayReset(
  status = 200,
  body = '{"ok":true}',
  headers: Record<string, string> = {}
) {
  relayCalls = [];
  relayReply = { status, body, headers };
}
// `duplex: "half"` is required by undici for a streamed request body and is
// absent from the DOM RequestInit type.
type StreamInit = RequestInit & { duplex: "half" };

await leg("relay: our secret and Via are SET, the caller's are not forwarded", async () => {
  relayReset();
  const res = await relayRoute.POST(
    new Request(`${U}/api/xlant/relay/v1/device/hello`, {
      method: "POST",
      body: '{"a":1}',
      headers: {
        "content-length": "7",
        "content-type": "application/json",
        authorization: "Bearer synthetic-device-token-0001",
        // Spoofs a caller might try. None may reach the relay.
        "x-xlant-via": "caller-spoof",
        "x-xlant-proxy-secret": "SYNTHETIC-ATTACKER-VALUE",
        cookie: "session=abc",
      },
    }),
    ctx("v1/device/hello")
  );
  assert.equal(res.status, 200);
  assert.equal(relayCalls.length, 1);
  const h = relayCalls[0].headers;
  assert.equal(h["x-xlant-proxy-secret"], SECRET, "the secret must be OURS");
  assert.equal(h["x-xlant-via"], "proxy", "Via must be SET, not passed through");
  assert.equal(h["authorization"], "Bearer synthetic-device-token-0001");
  assert.equal(h["content-type"], "application/json");
  assert.equal(h["cookie"], undefined, "no browser cookie may reach the relay");
  assert.equal(relayCalls[0].body, '{"a":1}');
  assert.equal(relayCalls[0].url, "/v1/device/hello");
  assert.equal(res.headers.get("cache-control"), "private, no-store");
});

await leg("relay: Cloudflare's country rides as X-XLAnt-Country, and nothing else does", async () => {
  // xlant contract 0.13.3 (the language round): the relay decides which
  // LANGUAGE a person reads XLAnt in, and the third of its four signals is the
  // country THIS request came from. Only Cloudflare can say it — nginx listens
  // on 127.0.0.1 behind cloudflared and Cloudflare replaces any client value —
  // and the relay only reads the header behind the proxy secret that is added
  // on this hop. What this leg pins is the three halves of that sentence: the
  // value is forwarded, it is forwarded UPPER-CASED under our own name, and a
  // caller's own X-XLAnt-Country never survives.
  const country = async (headers: Record<string, string>) => {
    relayReset();
    const res = await relayRoute.POST(
      new Request(`${U}/api/xlant/relay/v1/device/hello`, {
        method: "POST",
        body: "{}",
        headers: { "content-length": "2", "content-type": "application/json", ...headers },
      }),
      ctx("v1/device/hello")
    );
    assert.equal(res.status, 200);
    assert.equal(relayCalls.length, 1);
    return relayCalls[0].headers["x-xlant-country"];
  };

  assert.equal(
    await country({ "cf-ipcountry": "de", "x-xlant-country": "GB" }),
    "DE",
    "Cloudflare's country, upper-cased — and never the caller's own header"
  );
  assert.equal(
    await country({ "x-xlant-country": "GB" }),
    undefined,
    "no cf-ipcountry, no header: a device may not name its own country"
  );
  assert.equal(
    await country({}),
    undefined,
    "a request Cloudflare said nothing about carries nothing — the relay clears the column on every hello, and absent is truer than stale"
  );
  // Cloudflare's own unknown markers pass the SHAPE and are read as "nowhere"
  // by the relay (languagePolicy.cleanRegion); anything that is not two ASCII
  // letters is not a country and stops here.
  assert.equal(await country({ "cf-ipcountry": "XX" }), "XX");
  // (a header VALUE is trimmed by the Headers class, so " US " would arrive as
  //  "US" and is not a case this can express — the list is what really differs)
  for (const bad of ["T1", "USA", "d", "de-DE", "12", "u5", "../x"]) {
    assert.equal(
      await country({ "cf-ipcountry": bad }),
      undefined,
      `cf-ipcountry ${JSON.stringify(bad)} is not a country code`
    );
  }
});

await leg("relay: off-list and INTERNAL paths 404 without touching the relay", async () => {
  for (const rel of [
    "v1/device/issue",
    "v1/device/verify",
    "v1/status",
    "v1/providers/refresh",
    "v1/device/hello/x",
    "v1/mcp/a/b",
    "../v1/device/hello",
    "v1/incident/../../v1/device/issue",
    "v1/incident/inc1/tools/next/x",
    "",
    "v1/mcp",
  ]) {
    relayReset();
    const res = await relayRoute.GET(
      new Request(`${U}/api/xlant/relay/${rel}`),
      ctx(rel)
    );
    assert.equal(res.status, 404, `status for ${JSON.stringify(rel)}`);
    assert.equal(relayCalls.length, 0, `relay touched for ${rel}`);
  }
  relayReset();
  const res = await relayRoute.GET(
    new Request(`${U}/api/xlant/relay/v1/status`),
    ctx("v1/status")
  );
  assert.equal(await res.text(), '{"error":"not found"}');
  assert.equal(res.headers.get("cache-control"), "private, no-store");
});

await leg("relay: the MCP hop invents no Authorization and carries the session", async () => {
  relayReset();
  const res = await relayRoute.POST(
    new Request(`${U}/api/xlant/relay/v1/mcp/synthetic-bridge`, {
      method: "POST",
      body: '{"jsonrpc":"2.0"}',
      headers: {
        "content-length": "17",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": "SESS-1",
      },
    }),
    ctx("v1/mcp/synthetic-bridge")
  );
  assert.equal(res.status, 200);
  assert.equal(relayCalls.length, 1);
  assert.equal(
    relayCalls[0].headers["authorization"],
    undefined,
    "the bridge token in the path is the whole credential"
  );
  assert.equal(
    relayCalls[0].headers["accept"],
    "application/json, text/event-stream"
  );
  assert.equal(relayCalls[0].headers["mcp-session-id"], "SESS-1");
});

await leg("relay: body caps — 411, 413 declared, 413 streamed, 1 MB exactly", async () => {
  // A device POST with no Content-Length is refused outright.
  relayReset();
  const noLen = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode("x"));
      c.close();
    },
  });
  let res = await relayRoute.POST(
    new Request(`${U}/api/xlant/relay/v1/incident/start`, {
      method: "POST",
      body: noLen,
      duplex: "half",
    } as StreamInit),
    ctx("v1/incident/start")
  );
  assert.equal(res.status, 411, "device POST without Content-Length");
  assert.equal(relayCalls.length, 0);

  // The MCP path buffers a length-less body instead.
  relayReset();
  const chunked = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode('{"chunked":true}'));
      c.close();
    },
  });
  res = await relayRoute.POST(
    new Request(`${U}/api/xlant/relay/v1/mcp/synthetic-bridge`, {
      method: "POST",
      body: chunked,
      duplex: "half",
    } as StreamInit),
    ctx("v1/mcp/synthetic-bridge")
  );
  assert.equal(res.status, 200, "MCP chunked body is forwarded");
  assert.equal(relayCalls[0]?.body, '{"chunked":true}');

  // …under the same cap, and the read is abandoned rather than drained.
  relayReset();
  let sent = 0;
  const flood = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= 2 * 1024 * 1024) {
        c.close();
        return;
      }
      c.enqueue(new Uint8Array(64 * 1024));
      sent += 64 * 1024;
    },
  });
  res = await relayRoute.POST(
    new Request(`${U}/api/xlant/relay/v1/mcp/synthetic-bridge`, {
      method: "POST",
      body: flood,
      duplex: "half",
    } as StreamInit),
    ctx("v1/mcp/synthetic-bridge")
  );
  assert.equal(res.status, 413, "2 MB streamed to the MCP path");
  assert.equal(relayCalls.length, 0, "the relay never saw it");
  // The guarantee is that readCapped STOPS once the total passes the cap, not
  // that it stops on the exact byte: the producer may already have queued a
  // chunk or two behind the reader. What must not happen is draining all 2 MB.
  assert.ok(
    sent > 1024 * 1024 && sent <= 1024 * 1024 + 256 * 1024,
    `abandoned the read after ${sent} bytes (want just past the 1 MB cap)`
  );

  // A declared length over the cap is refused before the body is read…
  relayReset();
  res = await relayRoute.POST(
    new Request(`${U}/api/xlant/relay/v1/incident/start`, {
      method: "POST",
      body: "x",
      headers: { "content-length": String(1024 * 1024 + 1) },
    }),
    ctx("v1/incident/start")
  );
  assert.equal(res.status, 413);
  assert.equal(relayCalls.length, 0);

  // …and exactly 1 MB is allowed through.
  relayReset();
  res = await relayRoute.POST(
    new Request(`${U}/api/xlant/relay/v1/incident/start`, {
      method: "POST",
      body: "x",
      headers: { "content-length": String(1024 * 1024) },
    }),
    ctx("v1/incident/start")
  );
  assert.equal(res.status, 200, "exactly at the cap is not over it");

  // A non-numeric length is treated as no length at all.
  relayReset();
  res = await relayRoute.POST(
    new Request(`${U}/api/xlant/relay/v1/incident/start`, {
      method: "POST",
      body: "x",
      headers: { "content-length": "not-a-number" },
    }),
    ctx("v1/incident/start")
  );
  assert.equal(res.status, 411);
  assert.equal(relayCalls.length, 0);
});

await leg("relay: the query string reaches the relay verbatim", async () => {
  for (const [rel, qs] of [
    ["v1/incident/inc_1/tools/next", "?wait=25"],
    ["v1/incident/inc_1/events", "?since=7"],
  ] as const) {
    relayReset();
    await relayRoute.GET(new Request(`${U}/api/xlant/relay/${rel}${qs}`), ctx(rel));
    assert.equal(relayCalls[0]?.url, `/${rel}${qs}`);
  }
});

await leg("relay: upstream status, body and Mcp-Session-Id pass through", async () => {
  // 401 = revoked device token, 404 = unknown bridge token, 410 = ended run.
  // Each must reach the caller unchanged; a rewritten status would make the
  // desktop and Cursor mis-handle their own errors.
  for (const st of [401, 404, 410, 405, 500]) {
    relayReset(st, `{"error":"upstream-${st}"}`);
    const res = await relayRoute.POST(
      new Request(`${U}/api/xlant/relay/v1/mcp/synthetic-bridge`, {
        method: "POST",
        body: "{}",
        headers: { "content-length": "2" },
      }),
      ctx("v1/mcp/synthetic-bridge")
    );
    assert.equal(res.status, st);
    assert.equal(await res.text(), `{"error":"upstream-${st}"}`);
  }
  relayReset(200, "{}", { "mcp-session-id": "SESS-RETURNED" });
  let res = await relayRoute.POST(
    new Request(`${U}/api/xlant/relay/v1/mcp/synthetic-bridge`, {
      method: "POST",
      body: "{}",
      headers: { "content-length": "2" },
    }),
    ctx("v1/mcp/synthetic-bridge")
  );
  assert.equal(res.headers.get("mcp-session-id"), "SESS-RETURNED");
  assert.equal(res.headers.get("cache-control"), "private, no-store");

  relayReset(200, "data: hi\n\n", { "content-type": "text/event-stream" });
  res = await relayRoute.POST(
    new Request(`${U}/api/xlant/relay/v1/mcp/synthetic-bridge`, {
      method: "POST",
      body: "{}",
      headers: { "content-length": "2" },
    }),
    ctx("v1/mcp/synthetic-bridge")
  );
  assert.equal(res.headers.get("content-type"), "text/event-stream");
});

await leg("relay: down is 502 and slow is 504, never a bare 500", async () => {
  // An unguarded fetch throws out of the handler and `next start` answers with
  // its HTML error page, which tells an operator nothing and tells the desktop
  // less. Both failures answer JSON in this route's own shape.
  const saved = process.env.XLANT_RELAY_URL;
  process.env.XLANT_RELAY_URL = "http://127.0.0.1:1"; // nothing listens here
  let res = await relayRoute.POST(
    new Request(`${U}/api/xlant/relay/v1/incident/start`, {
      method: "POST",
      body: "{}",
      headers: { "content-length": "2" },
    }),
    ctx("v1/incident/start")
  );
  assert.equal(res.status, 502, "connection refused");
  assert.deepEqual(await res.json(), { error: "relay unreachable" });
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  process.env.XLANT_RELAY_URL = saved;

  // The AbortSignal firing, in both shapes undici produces: the DOMException
  // itself, and a TypeError wrapping it as `cause`.
  const timeout = () =>
    new DOMException("The operation was aborted due to timeout", "TimeoutError");
  for (const thrown of [
    timeout(),
    Object.assign(new TypeError("fetch failed"), { cause: timeout() }),
  ]) {
    const real = globalThis.fetch;
    globalThis.fetch = (() => {
      throw thrown;
    }) as unknown as typeof fetch;
    try {
      res = await relayRoute.POST(
        new Request(`${U}/api/xlant/relay/v1/incident/start`, {
          method: "POST",
          body: "{}",
          headers: { "content-length": "2" },
        }),
        ctx("v1/incident/start")
      );
    } finally {
      globalThis.fetch = real;
    }
    assert.equal(res.status, 504, "the AbortSignal firing is a timeout");
    assert.deepEqual(await res.json(), { error: "relay timeout" });
  }
});

// --- the artifacts directory, read the way the staff page reads it ---------

// The same three env vars the routes read, as a value the lib functions take
// directly (they are pure over a config, which is why the page can call them
// during a render).
const artCfg: XlantConfig = {
  relayUrl: `http://127.0.0.1:${RELAY_PORT}`,
  proxySecret: SECRET,
  artifactsDir: ART,
};

await leg("latestInstaller sees the Windows build and no Mac bundle", async () => {
  const found = await latestInstaller(artCfg);
  assert.equal(found?.fileName, "XLAnt-Setup-9.9.9.exe");
  assert.equal(found?.version, "9.9.9");
  assert.equal(found?.size, 4096, "size comes from the same stat as the mtime");
});

await leg("latestMacBundle answers per ARCHITECTURE, never per newest zip", async () => {
  // The two zips of one release differ only in mtime, so a single
  // newest-of-all would hand whichever finished writing last to everybody.
  const arm = await latestMacBundle(artCfg, "arm64");
  const intel = await latestMacBundle(artCfg, "x64");
  assert.equal(intel?.fileName, "XLAnt-9.9.9-x64-mac.zip");
  assert.equal(intel?.version, "9.9.9");
  assert.equal(intel?.arch, "x64");
  assert.equal(intel?.size, 6144);
  // NEWEST BY MTIME, not by parsed version: 9.9.8 was stamped later, and a
  // republished build of an older version must win exactly as it does on the
  // Windows side. This host invents no version ordering.
  assert.equal(arm?.fileName, "XLAnt-9.9.8-arm64-mac.zip");
  assert.equal(arm?.version, "9.9.8");
  assert.equal(arm?.arch, "arm64");
  assert.equal(arm?.size, 1024);
});

await leg("a directory with no Mac build, and an unreadable one, are null", async () => {
  const onlyWindows = mkdtempSync(join(tmpdir(), "xlant-nomac-"));
  writeFileSync(join(onlyWindows, "XLAnt-Setup-9.9.9.exe"), Buffer.alloc(8, 1));
  // The shapes that sit in a real directory and are NOT a servable bundle: the
  // publish step's temp file, a universal build and the arch-less name a build
  // without an explicit artifactName emits.
  writeFileSync(join(onlyWindows, "XLAnt-9.9.9-arm64-mac.zip.part"), "HALF\n");
  writeFileSync(join(onlyWindows, "XLAnt-9.9.9-universal-mac.zip"), "U\n");
  writeFileSync(join(onlyWindows, "XLAnt-9.9.9-mac.zip"), "N\n");
  try {
    for (const arch of ["arm64", "x64"] as const) {
      assert.equal(
        await latestMacBundle({ ...artCfg, artifactsDir: onlyWindows }, arch),
        null,
        `${arch} must not fall back to a name outside the contract`
      );
    }
    assert.ok(await latestInstaller({ ...artCfg, artifactsDir: onlyWindows }));
  } finally {
    rmSync(onlyWindows, { recursive: true, force: true });
  }
  // An unreadable directory is "nothing published", never a thrown page: this
  // runs inside a server render.
  const gone = { ...artCfg, artifactsDir: join(ROOT, "does-not-exist") };
  assert.equal(await latestInstaller(gone), null);
  assert.equal(await latestMacBundle(gone, "arm64"), null);
});

// --- the pre-mint probe ----------------------------------------------------

await leg("the Mac probe GETs /v1/status on the INTERNAL lane", async () => {
  relayReset(200, '{"ok":true,"platforms":["windows","mac"]}');
  assert.equal(await probeRelayMacSupport(artCfg), "supported");
  assert.equal(relayCalls.length, 1);
  assert.equal(relayCalls[0].method, "GET", "express routes /v1/status by GET");
  assert.equal(relayCalls[0].url, "/v1/status");
  assert.equal(relayCalls[0].headers["x-xlant-proxy-secret"], SECRET);
  assert.equal(
    relayCalls[0].headers["x-xlant-via"],
    undefined,
    "the internal lane must NOT carry the proxy marker — the relay rejects it"
  );
  assert.equal(relayCalls[0].body, "", "a GET carries no body");
});

await leg("a relay that does not name 'mac' is unsupported, not broken", async () => {
  // EVERY relay in production before 0.5.0: /v1/status answers 200 and simply
  // has no `platforms` key. That is the case this probe exists for.
  for (const body of [
    '{"ok":true,"version":"0.4.2"}',
    '{"ok":true,"platforms":[]}',
    '{"ok":true,"platforms":["windows"]}',
    // A `platforms` that is not a list is not a list of platforms.
    '{"ok":true,"platforms":"windows,mac"}',
    '{"ok":true,"platforms":{"mac":true}}',
    '{"ok":true,"platforms":null}',
  ]) {
    relayReset(200, body);
    assert.equal(await probeRelayMacSupport(artCfg), "unsupported", body);
  }
  // …and the nearest allow: 'mac' anywhere in the list is support.
  for (const body of [
    '{"ok":true,"platforms":["mac"]}',
    '{"ok":true,"platforms":["windows","mac"]}',
    '{"ok":true,"platforms":["mac","windows","linux"]}',
  ]) {
    relayReset(200, body);
    assert.equal(await probeRelayMacSupport(artCfg), "supported", body);
  }
});

await leg("a relay we cannot READ is 'unreadable', a different answer", async () => {
  // "The Mac lane is not deployed" and "the relay is down" are different
  // problems with different people to tell, so they must not collapse.
  for (const [status, body] of [
    [500, '{"error":"boom"}'],
    [401, '{"error":"unauthorized"}'],
    [404, "not found"],
  ] as const) {
    relayReset(status, body);
    assert.equal(await probeRelayMacSupport(artCfg), "unreadable", String(status));
  }
  // A 200 is not a promise of JSON: an intermediary can answer 200 with an
  // HTML error page, and an unguarded .json() would throw out of the mint.
  relayReset(200, "<html>gateway</html>");
  assert.equal(await probeRelayMacSupport(artCfg), "unreadable");
  relayReset(200, "null");
  assert.equal(await probeRelayMacSupport(artCfg), "unreadable");
  // Nothing listening at all.
  const dead: XlantConfig = { ...artCfg, relayUrl: "http://127.0.0.1:1" };
  assert.equal(await probeRelayMacSupport(dead), "unreadable");
});

const GOOD = "synthetic-device-token-aaaaaaaa";
const auth = { authorization: `Bearer ${GOOD}` };

await leg("update: no token, a short token and a bad token are all 401", async () => {
  resetXlantVerifyCache();
  relayReset();
  let res = await updateRoute.GET(
    new Request(`${U}/api/xlant/update/latest.yml`),
    ctx("latest.yml")
  );
  assert.equal(res.status, 401);
  assert.equal(relayCalls.length, 0, "no header, no relay call");

  res = await updateRoute.GET(
    new Request(`${U}/api/xlant/update/latest.yml`, {
      headers: { authorization: "Bearer short" },
    }),
    ctx("latest.yml")
  );
  assert.equal(res.status, 401);
  assert.equal(relayCalls.length, 0, "short token, still no relay call");

  // A refused token costs a call every time — negatives are never cached.
  relayReset(401, '{"error":"revoked"}');
  const BAD = "synthetic-device-token-bbbbbbbb";
  for (const expected of [1, 2]) {
    res = await updateRoute.GET(
      new Request(`${U}/api/xlant/update/latest.yml`, {
        headers: { authorization: `Bearer ${BAD}` },
      }),
      ctx("latest.yml")
    );
    assert.equal(res.status, 401);
    assert.equal(relayCalls.length, expected, "a refusal must not be cached");
  }
});

await leg("update: one verify serves the whole yml -> exe -> blockmap upgrade", async () => {
  resetXlantVerifyCache();
  relayReset(200, "{}");
  const yml = await updateRoute.GET(
    new Request(`${U}/api/xlant/update/latest.yml`, { headers: auth }),
    ctx("latest.yml")
  );
  assert.equal(yml.status, 200);
  assert.equal(relayCalls.length, 1, "verified once");
  assert.equal(relayCalls[0].url, "/v1/device/verify", "the INTERNAL route");
  assert.equal(relayCalls[0].headers["x-xlant-proxy-secret"], SECRET);
  assert.equal(
    relayCalls[0].headers["x-xlant-via"],
    undefined,
    "the internal lane must NOT carry the proxy marker"
  );
  assert.equal(yml.headers.get("content-type"), "text/yaml");
  assert.equal(
    yml.headers.get("content-length"),
    String(Buffer.byteLength(YML))
  );
  assert.equal(yml.headers.get("cache-control"), "private, no-store");

  const exe = await updateRoute.GET(
    new Request(`${U}/api/xlant/update/XLAnt-Setup-9.9.9.exe`, { headers: auth }),
    ctx("XLAnt-Setup-9.9.9.exe")
  );
  const map = await updateRoute.GET(
    new Request(`${U}/api/xlant/update/XLAnt-Setup-9.9.9.exe.blockmap`, {
      headers: auth,
    }),
    ctx("XLAnt-Setup-9.9.9.exe.blockmap")
  );
  assert.equal(relayCalls.length, 1, "the whole upgrade costs ONE verify");
  assert.equal(exe.status, 200);
  assert.equal(exe.headers.get("content-type"), "application/octet-stream");
  assert.equal(exe.headers.get("content-length"), "4096");
  assert.equal(map.status, 200);
  assert.equal(map.headers.get("content-length"), "64");
});

await leg("update: the macOS upgrade — latest-mac.yml -> zip -> blockmap", async () => {
  resetXlantVerifyCache();
  relayReset(200, "{}");
  const yml = await updateRoute.GET(
    new Request(`${U}/api/xlant/update/latest-mac.yml`, { headers: auth }),
    ctx("latest-mac.yml")
  );
  assert.equal(yml.status, 200);
  assert.equal(relayCalls.length, 1, "verified once");
  assert.equal(relayCalls[0].url, "/v1/device/verify");
  assert.equal(yml.headers.get("content-type"), "text/yaml");
  assert.equal(
    yml.headers.get("content-length"),
    String(Buffer.byteLength(YML_MAC))
  );
  assert.equal(yml.headers.get("cache-control"), "private, no-store");

  const zip = await updateRoute.GET(
    new Request(`${U}/api/xlant/update/XLAnt-9.9.9-arm64-mac.zip`, {
      headers: auth,
    }),
    ctx("XLAnt-9.9.9-arm64-mac.zip")
  );
  const map = await updateRoute.GET(
    new Request(`${U}/api/xlant/update/XLAnt-9.9.9-arm64-mac.zip.blockmap`, {
      headers: auth,
    }),
    ctx("XLAnt-9.9.9-arm64-mac.zip.blockmap")
  );
  assert.equal(relayCalls.length, 1, "the whole upgrade costs ONE verify");
  assert.equal(zip.status, 200);
  assert.equal(zip.headers.get("content-type"), "application/zip");
  assert.equal(zip.headers.get("content-length"), "8192");
  assert.equal(map.status, 200);
  // The blockmap of a zip is a blockmap, not a zip.
  assert.equal(map.headers.get("content-type"), "application/octet-stream");
  assert.equal(map.headers.get("content-length"), "96");

  // The Intel twin, so neither architecture is served by accident.
  const intel = await updateRoute.GET(
    new Request(`${U}/api/xlant/update/XLAnt-9.9.9-x64-mac.zip`, {
      headers: auth,
    }),
    ctx("XLAnt-9.9.9-x64-mac.zip")
  );
  assert.equal(intel.status, 200);
  assert.equal(intel.headers.get("content-length"), "6144");
});

await leg("update: the Mac names that EXIST but are not releases are 404", async () => {
  // Every file below is really on disk in the scratch artifacts dir, so a 404
  // here is the release gate's verdict and not a missing file — which is the
  // only version of this test worth having.
  resetXlantVerifyCache();
  relayReset(200, "{}");
  await updateRoute.GET(
    new Request(`${U}/api/xlant/update/latest-mac.yml`, { headers: auth }),
    ctx("latest-mac.yml")
  );
  for (const rel of [
    // The publish step's half-written manifest: served, electron-updater parses
    // a truncated manifest.
    "latest-mac.yml.part",
    // A universal bundle the desktop does not build.
    "XLAnt-9.9.9-universal-mac.zip",
    // The arch-less name a build without an explicit `mac.artifactName`
    // emits for x64. Refused, so a mis-named publish fails loudly here rather
    // than handing an unlabelled bundle to whoever asked for Intel.
    "XLAnt-9.9.9-mac.zip",
  ]) {
    const res = await updateRoute.GET(
      new Request(`${U}/api/xlant/update/${rel}`, { headers: auth }),
      ctx(rel)
    );
    assert.equal(res.status, 404, `GET ${rel}`);
    assert.deepEqual(await res.json(), { error: "not found" });
  }
  // A release-shaped Mac name that is simply not there is the same 404, so the
  // feed is not a directory oracle even for a device that IS signed in.
  const absent = await updateRoute.GET(
    new Request(`${U}/api/xlant/update/XLAnt-1.2.3-arm64-mac.zip`, {
      headers: auth,
    }),
    ctx("XLAnt-1.2.3-arm64-mac.zip")
  );
  assert.equal(absent.status, 404);
});

await leg("update: whole files only — Range is ignored, no Accept-Ranges", async () => {
  // Pinned because §5.22's "keep the previous release's blockmap" note would
  // otherwise read as a promise of differential downloads. The feed streams
  // the complete file and advertises no ranges, so electron-updater always
  // takes the full-download path — parity with roleplay's copy (same code),
  // and the thing a future Range implementation would change.
  resetXlantVerifyCache();
  relayReset(200, "{}");
  const res = await updateRoute.GET(
    new Request(`${U}/api/xlant/update/XLAnt-Setup-9.9.9.exe`, {
      headers: { ...auth, range: "bytes=0-99" },
    }),
    ctx("XLAnt-Setup-9.9.9.exe")
  );
  assert.equal(res.status, 200, "a Range request is answered 200, not 206");
  assert.equal(res.headers.get("content-length"), "4096", "the whole file");
  assert.equal(res.headers.get("accept-ranges"), null, "no ranges advertised");
});

await leg("update: traversal is 400 and a non-release name is 404", async () => {
  resetXlantVerifyCache();
  relayReset(200, "{}");
  // Seed a cached positive so every status below is the PATH's verdict.
  await updateRoute.GET(
    new Request(`${U}/api/xlant/update/latest.yml`, { headers: auth }),
    ctx("latest.yml")
  );
  for (const [rel, want] of [
    ["../latest.yml", 400],
    ["..", 400],
    ["a/b.yml", 400],
    ["sub/latest.yml", 400],
    ["../outside/secret.txt", 400],
    [".env", 400],
    ["", 400],
    // Safe names that are not releases (the .part file is the one that would
    // have handed the updater a truncated manifest).
    ["latest.yml.part", 404],
    ["notes.txt", 404],
    ["latest.yml.bak", 404],
    ["XLAnt-Setup-x.exe.exe", 404],
    // A release-shaped name that simply is not there.
    ["XLAnt-Setup-1.2.3.exe", 404],
  ] as const) {
    const res = await updateRoute.GET(
      new Request(`${U}/api/xlant/update/${rel}`, { headers: auth }),
      ctx(rel)
    );
    assert.equal(res.status, want, `GET ${JSON.stringify(rel)}`);
  }
  // The traversal target really exists; prove its content never leaves.
  const trav = await updateRoute.GET(
    new Request(`${U}/api/xlant/update/../outside/secret.txt`, { headers: auth }),
    ctx("../outside/secret.txt")
  );
  assert.equal(trav.status, 400);
  assert.ok(!(await trav.text()).includes("NEVER-SERVE"));
});

await leg("both routes answer 503 on a half-configured host", async () => {
  const saved = process.env.XLANT_PROXY_SHARED_SECRET;
  process.env.XLANT_PROXY_SHARED_SECRET = "tooshort";
  relayReset();
  const a = await relayRoute.GET(
    new Request(`${U}/api/xlant/relay/v1/device/hello`),
    ctx("v1/device/hello")
  );
  const b = await updateRoute.GET(
    new Request(`${U}/api/xlant/update/latest.yml`, { headers: auth }),
    ctx("latest.yml")
  );
  assert.equal(a.status, 503);
  assert.equal(b.status, 503);
  assert.equal(relayCalls.length, 0, "an unarmed host contacts nothing");
  process.env.XLANT_PROXY_SHARED_SECRET = saved;
});

// ===========================================================================
// 8b. THE STAFF ROUTES, in-process, WITH A REAL SIGNED SESSION
// ===========================================================================
//
// Everything above this line runs without a session, and until 2026-09-08 that
// was the whole story: `readSession()` reads `next/headers`, `next/headers`
// needs a Next request scope, and this file has none — which is why the staff
// routes were pinned by reading their source rather than by running them, and
// why `xlantDownloadRequest()` was extracted as a pure function in the first
// place.
//
// That is no longer good enough. The two routes added in this round hand out
// and take away access to real machines, and the ONE property that matters
// most about them cannot be seen in a source grep: that the email the relay is
// told comes from the SESSION and never from the request body. A caller who
// could name someone else would list that person's computers and sign them
// out. So the request scope is FAKED here, with Next's own storages:
//
//   · `workAsyncStorage` + `workUnitAsyncStorage` (the `.external` entry
//     points, which is what `next/headers` itself reads) are given a minimal
//     `type: 'request'` store carrying a sealed Headers and RequestCookies
//     built from one cookie string;
//   · the session inside that cookie is minted by the REAL `signSession()`
//     with a synthetic `SESSION_COOKIE_SECRET`, so the real
//     `verifySessionToken()` accepts it and the real `requireXlantStaff()`
//     applies the real /rfp predicates to it.
//
// Nothing is stubbed: the route, the gate, the domain and provider tests and
// the relay call are all the shipped code. Two things to know when this
// breaks. (1) It depends on Next internals, so a Next upgrade can move them —
// the failure is loud and local, and the fix is this harness, never the
// routes. (2) `readSession()` also checks whether the account has been
// archived, which needs a database; there is none here, it FAILS OPEN by
// design, and each distinct email therefore prints one
// `archived-session check failed open: DATABASE_URL environment variable is
// not set` line into this output. That line is expected.
//
// NO REAL SECRET AND NO REAL SESSION: the cookie secret below is filler, and
// the sessions are minted, used and dropped inside this process.

const { workAsyncStorage } = await import(
  "next/dist/server/app-render/work-async-storage.external.js"
);
const { workUnitAsyncStorage } = await import(
  "next/dist/server/app-render/work-unit-async-storage.external.js"
);
const { HeadersAdapter } = await import(
  "next/dist/server/web/spec-extension/adapters/headers.js"
);
const { RequestCookiesAdapter } = await import(
  "next/dist/server/web/spec-extension/adapters/request-cookies.js"
);
const { RequestCookies } = await import(
  "next/dist/server/web/spec-extension/cookies.js"
);
const { signSession } = await import("@aicompany/core/auth/session");
const { siteConfig } = await import("site.config");

process.env.SESSION_COOKIE_SECRET = "synthetic-session-secret-for-xlant-tests";

const devicesRoute = await import("../src/app/api/internal/xlant/devices/route");
const revokeRoute = await import(
  "../src/app/api/internal/xlant/devices/revoke/route"
);
const mintRoute = await import(
  "../src/app/api/internal/xlant/device-token/route"
);

const LIST_PATH = "/api/internal/xlant/devices";
const REVOKE_PATH = "/api/internal/xlant/devices/revoke";
const MINT_PATH = "/api/internal/xlant/device-token";

/** A staff session, and the two shapes /rfp refuses. `Adam@xl.net` is mixed
 * case on purpose: the routes lowercase it and the relay is keyed on the
 * lowercased address. */
const STAFF = {
  userId: "u-staff",
  email: "Adam@xl.net",
  displayName: "Adam",
  provider: "google",
};
const OTHER_DOMAIN = {
  userId: "u-gmail",
  email: "someone@gmail.com",
  provider: "google",
};
// Microsoft WITHOUT the per-login `mv: true` claim — MICROSOFT_TENANT_ID is
// "common", so this is the forgery path §5.17 exists to close.
const UNVERIFIED = {
  userId: "u-ms",
  email: "adam@xl.net",
  provider: "microsoft",
};

const cookieFor = (claims: { userId: string; email: string }): string =>
  `${siteConfig.auth.sessionCookieName}=${signSession(siteConfig, claims)}`;

/** Run `fn` as if Next had just handed it a request carrying `cookie`. */
function inScope<T>(
  cookie: string | null,
  route: string,
  fn: () => Promise<T>
): Promise<T> {
  const h = new Headers(cookie ? { cookie } : {});
  // `phase: 'render'` rather than 'action': cookies() then reads the READONLY
  // jar, which is all readSession() wants, and nothing here writes one.
  const requestStore = {
    type: "request",
    phase: "render",
    headers: HeadersAdapter.seal(h),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(h)),
    mutableCookies: new RequestCookies(h),
    userspaceMutableCookies: new RequestCookies(h),
    implicitTags: undefined,
    url: { pathname: route, search: "" },
    rootParams: {},
    draftMode: undefined,
    devFallbackParams: null,
  };
  const workStore = { route, forceStatic: false, dynamicShouldError: false };
  return workAsyncStorage.run(workStore as never, () =>
    workUnitAsyncStorage.run(requestStore as never, fn)
  );
}

const post = (path: string, body: unknown): Request =>
  new Request(`${U}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const errorOf = async (res: Response): Promise<unknown> =>
  ((await res.json()) as { error?: unknown }).error;

await leg("the fake request scope works at all (harness self-check)", async () => {
  // BOTH DIRECTIONS, and the POSITIVE one is the whole point (refuter R3).
  // A scope whose cookie jar is broken answers "no session" for every caller,
  // so a self-check that asserted only the 401 would stay green while every
  // product leg below failed — which is exactly what R3 measured by mutating
  // the jar: eight legs red, this one still ok. If Next moves its storages,
  // the failure must land HERE and by name, not scattered across the section.
  relayReset(200, '{"ok":true,"email":"adam@xl.net","devices":[]}');
  const out = await inScope(null, LIST_PATH, () => devicesRoute.GET());
  assert.equal(out.status, 401, "a scope with no cookie must reach the gate");
  assert.equal(await errorOf(out), "unauthenticated");
  assert.equal(relayCalls.length, 0, "…and must not reach the relay");

  // The jar is READABLE: a signed staff session gets through the real
  // requireXlantStaff() and the relay is called as that person. Anything less
  // than a 200 here means the harness, not the route, is broken.
  const inside = await inScope(cookieFor(STAFF), LIST_PATH, () =>
    devicesRoute.GET()
  );
  assert.equal(
    inside.status,
    200,
    "a scope carrying a signed staff session must be READ — the jar is broken"
  );
  assert.equal(relayCalls.length, 1, "…and the route must reach the relay");
  assert.match(
    relayCalls[0].url,
    /email=adam%40xl\.net/,
    "…as the person the cookie names"
  );
});

await leg("the computer routes answer 503 BEFORE they look at a session", async () => {
  const saved = process.env.XLANT_PROXY_SHARED_SECRET;
  delete process.env.XLANT_PROXY_SHARED_SECRET;
  relayReset();
  // Called with NO request scope at all. `readSession()` THROWS outside one,
  // so a clean 503 is proof the arming gate runs first: an unconfigured host
  // must not go looking for who is asking.
  const list = await devicesRoute.GET();
  assert.equal(list.status, 503);
  assert.equal(await errorOf(list), "XLAnt is not configured on this host");
  const rev = await revokeRoute.POST(post(REVOKE_PATH, { deviceId: "dev_1" }));
  assert.equal(rev.status, 503);
  assert.equal(relayCalls.length, 0, "an unarmed host contacts nothing");
  process.env.XLANT_PROXY_SHARED_SECRET = saved;
});

await leg("signed out is 401, and the relay is never called", async () => {
  relayReset();
  for (const call of [
    () => inScope(null, LIST_PATH, () => devicesRoute.GET()),
    () =>
      inScope(null, REVOKE_PATH, () =>
        revokeRoute.POST(post(REVOKE_PATH, { deviceId: "dev_1" }))
      ),
  ]) {
    const res = await call();
    assert.equal(res.status, 401);
    assert.equal(await errorOf(res), "unauthenticated");
    // A staff inventory is one person's, so no cache anywhere may hold it —
    // including the refusals, which name the reason.
    assert.equal(res.headers.get("cache-control"), "no-store, private");
  }
  assert.equal(relayCalls.length, 0, "no session, no internal call");
});

await leg("a signed-in NON-staff caller is 403, with the reason that is true", async () => {
  relayReset();
  for (const [claims, reason] of [
    [OTHER_DOMAIN, "wrong_domain"],
    [UNVERIFIED, "wrong_provider"],
  ] as const) {
    const cookie = cookieFor(claims);
    const list = await inScope(cookie, LIST_PATH, () => devicesRoute.GET());
    assert.equal(list.status, 403, reason);
    assert.equal(await errorOf(list), reason);
    const rev = await inScope(cookie, REVOKE_PATH, () =>
      revokeRoute.POST(post(REVOKE_PATH, { deviceId: "dev_1" }))
    );
    assert.equal(rev.status, 403, reason);
    assert.equal(await errorOf(rev), reason);
  }
  assert.equal(relayCalls.length, 0, "a refused session reaches no relay");
});

// The two rows the fake relay answers with: one settled machine (reported in,
// so no clock) and one token that has never been pasted anywhere, which is the
// state a fresh mint leaves and the only state that carries an `expiresAt`.
const ROWS = [
  {
    deviceId: "dev_one",
    kind: "windows",
    machineName: "XL-LPT-A1",
    userName: "adam",
    clientVersion: "0.11.2",
    createdAt: "2026-09-04T10:00:00.000Z",
    lastSeenAt: "2026-09-08T11:00:00.000Z",
    expiresAt: null,
    openIncidents: 2,
  },
  {
    deviceId: "dev_two",
    kind: "mac",
    machineName: null,
    userName: null,
    clientVersion: null,
    createdAt: "2026-09-08T11:30:00.000Z",
    lastSeenAt: null,
    expiresAt: "2026-09-15T11:30:00.000Z",
    openIncidents: 0,
  },
];

await leg("the list is a GET on the INTERNAL lane, keyed on the SESSION's email", async () => {
  relayReset(200, JSON.stringify({ ok: true, email: "adam@xl.net", devices: ROWS }));
  const res = await inScope(cookieFor(STAFF), LIST_PATH, () => devicesRoute.GET());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store, private");
  assert.deepEqual(await res.json(), { devices: ROWS });

  assert.equal(relayCalls.length, 1);
  assert.equal(relayCalls[0].method, "GET", "express routes the list by GET");
  // LOWERCASED (the session says "Adam@xl.net") and percent-escaped: an email
  // is user-controlled text, and a raw `&` in one would invent a parameter.
  assert.equal(relayCalls[0].url, "/v1/device/list?email=adam%40xl.net");
  assert.equal(relayCalls[0].headers["x-xlant-proxy-secret"], SECRET);
  assert.equal(
    relayCalls[0].headers["x-xlant-via"],
    undefined,
    "the internal lane must NOT carry the proxy marker — the relay rejects it"
  );
  assert.equal(relayCalls[0].body, "", "a GET carries no body");
});

await leg("a body `email` is IGNORED: the sign-out names the SESSION's person", async () => {
  // THE leg this whole harness exists for. If the body could name someone,
  // any staffer could sign any colleague's laptop out of XLAnt.
  relayReset(200, '{"ok":true,"deviceId":"dev_one","superseded":3}');
  const res = await inScope(cookieFor(STAFF), REVOKE_PATH, () =>
    revokeRoute.POST(
      post(REVOKE_PATH, { deviceId: "dev_one", email: "victim@xl.net" })
    )
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, deviceId: "dev_one" });
  assert.equal(relayCalls.length, 1);
  assert.equal(relayCalls[0].method, "POST");
  assert.equal(relayCalls[0].url, "/v1/device/revoke");
  assert.deepEqual(JSON.parse(relayCalls[0].body), {
    email: "adam@xl.net",
    deviceId: "dev_one",
  });
  assert.ok(
    !relayCalls[0].body.includes("victim"),
    "a body email must not reach the relay in any field"
  );
});

await leg("the mint takes its email from the session too, whatever the body says", async () => {
  // The same property on the route that has had it since day one, now
  // MEASURED rather than read: a session can be faked here, so it is.
  relayReset(
    200,
    '{"ok":true,"deviceId":"dev_new","token":"synthetic-minted-token-0001","kind":"windows","expiresAt":"2026-09-15T12:00:00.000Z"}'
  );
  const res = await inScope(cookieFor(STAFF), MINT_PATH, () =>
    mintRoute.POST(post(MINT_PATH, { kind: "windows", email: "victim@xl.net" }))
  );
  assert.equal(res.status, 200);
  const answered = await res.text();
  assert.deepEqual(JSON.parse(answered), {
    token: "synthetic-minted-token-0001",
    kind: "windows",
  });
  // The mint answers `{token, kind}` and NOTHING else: every other field the
  // relay sends is dropped here rather than forwarded, so the button cannot
  // put a fact on screen that this host never looked at. (The seven-day clock
  // a fresh token is on reaches the staffer through the computer list, which
  // reads `expiresAt` deliberately, and through the button's own fixed
  // sentence — not by echoing whatever the relay attached to the mint.)
  assert.ok(!answered.includes("expiresAt"));
  assert.ok(!answered.includes("deviceId"));
  assert.equal(relayCalls.length, 1, "a windows mint does not probe");
  assert.equal(relayCalls[0].url, "/v1/device/issue");
  const sent = JSON.parse(relayCalls[0].body) as Record<string, unknown>;
  assert.equal(sent.email, "adam@xl.net");
  assert.equal(sent.displayName, "Adam");
  assert.equal(sent.kind, "windows");
});

await leg("a list this host cannot read is 502, and NEVER an empty list", async () => {
  for (const body of [
    '{"ok":true}',
    '{"ok":true,"devices":null}',
    '{"ok":true,"devices":{"0":{"deviceId":"x"}}}',
    "<html>gateway</html>",
    "null",
  ]) {
    relayReset(200, body);
    const res = await inScope(cookieFor(STAFF), LIST_PATH, () => devicesRoute.GET());
    assert.equal(res.status, 502, body);
    assert.equal(await errorOf(res), "relay returned no device list", body);
  }
});

await leg("a refusal and a silence get their own 502 sentence, per route", async () => {
  relayReset(500, '{"error":"boom"}');
  const list = await inScope(cookieFor(STAFF), LIST_PATH, () => devicesRoute.GET());
  assert.equal(list.status, 502);
  assert.equal(await errorOf(list), "relay refused the device list");

  relayReset(500, '{"error":"boom"}');
  const rev = await inScope(cookieFor(STAFF), REVOKE_PATH, () =>
    revokeRoute.POST(post(REVOKE_PATH, { deviceId: "dev_one" }))
  );
  assert.equal(rev.status, 502);
  assert.equal(await errorOf(rev), "relay refused the sign-out");

  // Nothing listening at all: the timeout/DNS/refused branch, which the island
  // answers with "try again in a moment" and the refusal branch does not.
  const savedUrl = process.env.XLANT_RELAY_URL;
  process.env.XLANT_RELAY_URL = "http://127.0.0.1:1";
  const deadList = await inScope(cookieFor(STAFF), LIST_PATH, () => devicesRoute.GET());
  assert.equal(deadList.status, 502);
  assert.equal(await errorOf(deadList), "the XLAnt relay did not answer");
  const deadRev = await inScope(cookieFor(STAFF), REVOKE_PATH, () =>
    revokeRoute.POST(post(REVOKE_PATH, { deviceId: "dev_one" }))
  );
  assert.equal(deadRev.status, 502);
  assert.equal(await errorOf(deadRev), "the XLAnt relay did not answer");
  process.env.XLANT_RELAY_URL = savedUrl;
});

await leg("the relay's 404 stays a 404 — nothing to do is not a failure", async () => {
  relayReset(404, '{"ok":false,"error":"not_found"}');
  const res = await inScope(cookieFor(STAFF), REVOKE_PATH, () =>
    revokeRoute.POST(post(REVOKE_PATH, { deviceId: "dev_gone" }))
  );
  assert.equal(res.status, 404);
  assert.equal(
    await errorOf(res),
    "that computer is not yours or is already signed out"
  );
});

await leg("a deviceId that could never be one is 400, and never leaves this host", async () => {
  const cookie = cookieFor(STAFF);
  for (const body of [
    {},
    { deviceId: "" },
    { deviceId: " " },
    { deviceId: "dev one" },
    { deviceId: "dev/one" },
    { deviceId: "../dev" },
    { deviceId: "dev_one&email=victim@xl.net" },
    { deviceId: "a".repeat(81) },
    { deviceId: 7 },
    { deviceId: null },
    { deviceId: ["dev_one"] },
  ]) {
    relayReset();
    const res = await inScope(cookie, REVOKE_PATH, () =>
      revokeRoute.POST(post(REVOKE_PATH, body))
    );
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(await errorOf(res), "deviceId must be a device id");
    assert.equal(
      relayCalls.length,
      0,
      `a malformed id reached the relay: ${JSON.stringify(body)}`
    );
  }
  // …and a body that is not a JSON object at all, read AFTER the gate so a
  // malformed body never tells an anonymous caller what this route takes.
  for (const raw of ["[1,2]", "null", '"dev_one"', "{oops"]) {
    relayReset();
    const res = await inScope(cookie, REVOKE_PATH, () =>
      revokeRoute.POST(
        new Request(`${U}${REVOKE_PATH}`, { method: "POST", body: raw })
      )
    );
    assert.equal(res.status, 400, raw);
    assert.equal(relayCalls.length, 0, raw);
  }
});

// ===========================================================================
// 9. THE REAL MIDDLEWARE, in-process
// ===========================================================================

await leg("CSRF: Origin-less device POSTs pass, /api/internal/xlant does not", async () => {
  const { NextRequest } = await import("next/server");
  const middleware = (await import("../src/proxy")).default;
  const run = async (
    method: string,
    url: string,
    headers: Record<string, string> = {}
  ) => middleware(new NextRequest(new Request(url, { method, headers })));

  // The device lane. Neither the Windows desktop nor Cursor's cloud VM sends
  // an Origin, so every one of these MUST pass; a 403 here is the whole
  // feature broken.
  for (const [method, path] of [
    ["POST", "/api/xlant/relay/v1/device/hello"],
    ["POST", "/api/xlant/relay/v1/incident/start"],
    ["POST", "/api/xlant/relay/v1/incident/i/decision"],
    ["POST", "/api/xlant/relay/v1/incident/i/tools/c/result"],
    ["POST", "/api/xlant/relay/v1/mcp/synthetic-bridge"],
    ["GET", "/api/xlant/relay/v1/incident/i/tools/next?wait=25"],
    ["GET", "/api/xlant/update/latest.yml"],
    ["GET", "/api/xlant/update/XLAnt-Setup-9.9.9.exe"],
  ] as const) {
    const res = await run(method, `${U}${path}`);
    assert.notEqual(res.status, 403, `${method} ${path} was CSRF-refused`);
    // No attribution cookie is set on an API path either — isPagePath()
    // excludes /api, so the device lane is invisible to tracking.
    assert.equal(
      res.headers.get("set-cookie"),
      null,
      `${path} set a cookie on a device request`
    );
  }

  // The CONTROL: the browser-called half is still protected, so this proves
  // the check is live rather than globally disabled in this harness. BOTH
  // staff POSTs sit under the one `/api/internal/xlant` prefix and both must
  // refuse an Origin-less POST — the sign-out most of all, since a cross-site
  // POST to it would take a colleague's laptop off the air from a page they
  // merely visited. No new prefix was added for the 2026-09-08 routes; they
  // inherit this one, which is the whole reason they live under that path.
  for (const path of [
    "/api/internal/xlant/device-token",
    "/api/internal/xlant/devices/revoke",
  ]) {
    const noOrigin = await run("POST", `${U}${path}`);
    assert.equal(noOrigin.status, 403, `${path} must refuse an Origin-less POST`);
    const sameOrigin = await run("POST", `${U}${path}`, { origin: U });
    assert.notEqual(sameOrigin.status, 403, `${path}: a same-origin POST must pass`);
  }
  // The list is a GET and the check does not apply to it; it must not be
  // refused for want of an Origin either, or the section never loads.
  const listGet = await run("GET", `${U}/api/internal/xlant/devices`);
  assert.notEqual(listGet.status, 403, "the computer list must not be CSRF-refused");
});

// ===========================================================================
// 10. Source invariants the type system cannot express
// ===========================================================================

const readRepo = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

await leg("both device routes keep the runtime knobs they depend on", () => {
  const read = readRepo;
  const relaySrc = read("src/app/api/xlant/relay/[[...path]]/route.ts");
  const updateSrc = read("src/app/api/xlant/update/[[...path]]/route.ts");
  for (const [name, src] of [
    ["relay", relaySrc],
    ["update", updateSrc],
  ] as const) {
    assert.match(src, /export const runtime = "nodejs";/, `${name}: runtime`);
    assert.match(src, /export const dynamic = "force-dynamic";/, `${name}: dynamic`);
    assert.match(src, /"Cache-Control": "private, no-store"/, `${name}: cache`);
  }
  // maxDuration is DECLARED but inert on this self-hosted `next start` —
  // nothing under next/dist/server reads it, only the build manifest carries
  // it. It is pinned so a platform move that DOES enforce a function budget
  // inherits a 300 s one; the operative ceilings are Cloudflare's 100 s edge
  // close and nginx's 120 s proxy_read_timeout, neither of which lives here.
  assert.match(relaySrc, /export const maxDuration = 300;/);
  assert.match(relaySrc, /AbortSignal\.timeout\(290_000\)/);
  // The allowlist is imported, never re-declared: a second copy is a second
  // thing to forget when the xlant contract changes.
  assert.match(relaySrc, /isXlantRelayPath/);
  assert.ok(
    !relaySrc.includes("/^v1"),
    "the relay route must not carry its own copy of the allowlist"
  );
});

await leg("the staff download keeps its runtime knobs and its one decision", () => {
  const src = readRepo("src/app/api/internal/xlant/download/route.ts");
  assert.match(src, /export const runtime = "nodejs";/);
  assert.match(src, /export const dynamic = "force-dynamic";/);
  assert.match(src, /"Cache-Control": "private, no-store"/);
  // The platform/arch decision is the pure function pinned in section 6, not a
  // second copy of the same branching: a second copy is a second thing to
  // forget when a third build target appears.
  assert.match(src, /xlantDownloadRequest\(/);
  assert.ok(
    !src.includes('params.get("platform")'),
    "the route must not re-read the query string itself"
  );
});

await leg("every download link the page draws is one the route accepts", () => {
  const page = readRepo("src/app/internal/xlant/page.tsx");
  // JSX attributes are plain JS strings, so `&` is literal here — no entity
  // decoding, and what the browser requests is what this reads.
  const hrefs = [
    ...page.matchAll(/href="(\/api\/internal\/xlant\/download[^"]*)"/g),
  ].map((m) => m[1]);
  assert.equal(hrefs.length, 3, "one Windows link and two Mac links");
  const seen: string[] = [];
  for (const href of hrefs) {
    const qs = href.includes("?") ? href.slice(href.indexOf("?") + 1) : "";
    const want = xlantDownloadRequest(new URLSearchParams(qs));
    assert.ok(want.ok, `the page links a download the route refuses: ${href}`);
    seen.push(want.platform === "mac" ? `mac:${want.arch}` : want.platform);
  }
  assert.deepEqual(seen.sort(), ["mac:arm64", "mac:x64", "windows"]);
  // One token button per kind, mounted inside its own card.
  assert.match(page, /<DeviceTokenButton kind="windows" \/>/);
  assert.match(page, /<DeviceTokenButton kind="mac" \/>/);
});

await leg("the Mac mint probes first, and the button can read the refusals", () => {
  const mint = readRepo("src/app/api/internal/xlant/device-token/route.ts");
  const button = readRepo("src/app/internal/xlant/token-button.tsx");
  // The probe is guarded by the kind: a Windows mint has worked since day one
  // and must not acquire a second relay round-trip, let alone a second way to
  // fail.
  assert.match(mint, /if \(kind === "mac"\) \{/);
  assert.match(mint, /probeRelayMacSupport\(cfg\)/);
  assert.ok(
    mint.indexOf("probeRelayMacSupport") <
      mint.indexOf('relayInternal(cfg, "/v1/device/issue"'),
    "the probe must run BEFORE the mint, or it proves nothing"
  );
  assert.ok(mint.includes(JSON.stringify("kind must be 'windows' or 'mac'")));
  // A typed code is a fine thing to log and a poor thing to read. Both
  // sentences a staffer can actually provoke from the Mac button must exist
  // verbatim in the button's map, or the page shows a raw error string.
  for (const sentence of [
    "the relay does not support Mac tokens yet (needs relay 0.5.0)",
    "the XLAnt relay did not answer",
  ]) {
    const quoted = JSON.stringify(sentence);
    assert.ok(mint.includes(quoted), `the mint should answer ${quoted}`);
    assert.ok(button.includes(quoted), `the button cannot read ${quoted}`);
  }
  // The client island must never import the server module: it reads node:fs
  // and the XLAnt shared secret, and bundling it into a client would ship both.
  assert.ok(
    !/^\s*import\b[^;]*["']@\/lib\/xlant["']/m.test(button),
    "the token button must inline its kinds, not import the server module"
  );
});

await leg("the computer-list routes keep their knobs and their session-only identity", () => {
  for (const rel of [
    "src/app/api/internal/xlant/devices/route.ts",
    "src/app/api/internal/xlant/devices/revoke/route.ts",
  ]) {
    const src = readRepo(rel);
    assert.match(src, /export const runtime = "nodejs";/, `${rel}: runtime`);
    assert.match(src, /export const dynamic = "force-dynamic";/, `${rel}: dynamic`);
    assert.match(src, /export const revalidate = 0;/, `${rel}: revalidate`);
    assert.match(src, /"cache-control": "no-store, private"/, `${rel}: cache`);
    // The identity is the session's, lowercased, and there is no second
    // reader of an email anywhere in the file. Section 8b proves the behaviour
    // against the fake relay; this refuses the SHAPE of the mistake, which is
    // the one a hurried edit makes ("just fall back to the body").
    assert.match(src, /session\.email\.toLowerCase\(\)/, `${rel}: session email`);
    assert.ok(
      !/body\.email|body\["email"\]|req\.email/.test(src),
      `${rel} reads an email from somewhere other than the session`
    );
  }
});

await leg("the page states the token rule this build actually implements", () => {
  const page = readRepo("src/app/internal/xlant/page.tsx");
  // JSX wraps prose across source lines, so a sentence is matched against the
  // page with its whitespace collapsed. (A pin that only worked while a
  // sentence happened to fit on one line would go quiet on the next reflow —
  // which is exactly how a false sentence survives a rewrite.)
  const prose = page.replace(/\s+/g, " ");
  // The retired downloads page is history: roleplay.xl.net has carried nothing
  // of XLAnt since 2026-09-04, and a live page must not send anyone looking.
  assert.ok(!page.includes("roleplay.xl.net"), "the retired page is still named");
  // Peer round xlant-a0: XLAnt is the one that does the work, and XL.net is
  // never named as a party that does it.
  assert.ok(
    !page.includes("XL.net technician agent"),
    "XL.net is still named as the party that goes to work"
  );
  // The 2026-09-08 truth, and the section that makes signing out possible.
  assert.match(prose, /One token per computer/);
  assert.match(page, /<DevicesList \/>/);
  assert.ok(
    !prose.includes("generating one never signs the other out"),
    "the single-token-per-kind paragraph is still on the page"
  );
  // A mint replaces NOTHING; an unused token is dealt with by time. Both
  // halves are pinned, because the first draft of this round said the mint
  // replaced the person's own unused token of that kind — a smaller lie than
  // the one before it, but a lie.
  assert.ok(
    !prose.includes("never pasted anywhere is replaced"),
    "the page still describes a mint replacing an unused token"
  );
  assert.ok(
    !prose.includes("The only thing a new token replaces"),
    "the page still describes a mint replacing anything"
  );
  assert.match(prose, /expires on its own/);
  assert.match(prose, /seven days/);
  // REFUTER R2, F9: the daily check-up runs with nobody watching, so "only
  // while you are watching" was false the day it was written. What is true is
  // that nothing is CHANGED without a Yes, and that the check-up only looks.
  assert.ok(
    !prose.includes("while you are watching"),
    "the page still claims XLAnt only acts while the person watches"
  );
  assert.ok(
    !prose.includes("Nothing runs on your machine"),
    "the privacy note still makes the same claim in other words"
  );
  assert.match(prose, /nothing on it is changed until you click/);
  assert.match(prose, /that check-up only looks/);
  // REFUTER R2, F8: the relay binds the machine name at an INCIDENT, not at
  // connect, so a reinstalled XLAnt does not retire the old token by
  // connecting and both rows are live until it reports something.
  assert.ok(
    !prose.includes("the first time that computer reports in"),
    "the page still says the old token goes when the computer merely connects"
  );
  assert.match(prose, /the first time the new one reports something/);
  assert.match(prose, /you may see two rows/);
  // REFUTER R3: on deploy day the fleet's existing computers arrive here
  // NAMELESS — the relay back-fills a name from a device's own later incidents
  // only — so the one active machine will read "Windows · no name yet · 3
  // open" until it next reports. The section has to say that is ordinary, or
  // the page invents a fault the staffer will go looking for.
  assert.match(prose, /that is normal, and the computer is working/);
  // And a row is a TOKEN, not a computer: after a reinstall one laptop
  // legitimately has two rows, which the old bijection sentence denied.
  assert.ok(
    !prose.includes("A row is one computer holding one token"),
    "the section still promises one row per computer"
  );
});

await leg("the mint and the list agree, and neither island imports the server module", () => {
  const button = readRepo("src/app/internal/xlant/token-button.tsx");
  const island = readRepo("src/app/internal/xlant/devices-list.tsx");
  // The sentence that was true until 2026-09-08 and is a lie now.
  assert.ok(
    !button.includes("has just been signed out"),
    "the button still claims a mint signs another computer out"
  );
  assert.ok(button.includes("Your other computers stay signed in."));
  // Per kind, and naming the right machine in each, so the two cards cannot
  // drift into describing the same mint differently.
  assert.ok(
    button.includes(
      "If you do not paste this Windows token into a PC, it expires on its own seven days from now."
    )
  );
  assert.ok(
    button.includes(
      "If you do not paste this Mac token into a Mac, it expires on its own seven days from now."
    )
  );
  assert.ok(
    !button.includes("is replaced by this one"),
    "the button still claims a mint replaces an earlier token"
  );
  // The one line that must survive every rewrite of that paragraph.
  assert.ok(button.includes("Copy it now — it is not shown again."));
  // ONE event name, spelled in two files that must not import each other.
  const EVENT = '"xlant:devices-changed"';
  assert.ok(button.includes(`const DEVICES_CHANGED_EVENT = ${EVENT};`));
  assert.ok(island.includes(`export const DEVICES_CHANGED_EVENT = ${EVENT};`));
  assert.match(
    button,
    /window\.dispatchEvent\(new CustomEvent\(DEVICES_CHANGED_EVENT\)\)/,
    "a successful mint must tell the list"
  );
  assert.match(
    island,
    /addEventListener\(DEVICES_CHANGED_EVENT/,
    "the list must listen for it"
  );
  // Both islands: @/lib/xlant reads node:fs and the XLAnt shared secret, and
  // bundling it into a client would ship both.
  for (const [name, src] of [
    ["token button", button],
    ["devices list", island],
  ] as const) {
    assert.ok(
      !/^\s*import\b[^;]*["']@\/lib\/xlant["']/m.test(src),
      `the ${name} must inline its shapes, not import the server module`
    );
  }
});

await leg("no XLAnt JSX text node is glued to the word before it", () => {
  // THE SWC "GLUED TEXT" DEFECT, which has shipped on this host twice: a JSX
  // text node that contains BOTH a newline AND a decodable HTML entity loses
  // ALL of its leading whitespace at build time, so the word before it ships
  // joined on — `<strong>seven days</strong> later,` renders "seven dayslater".
  // It is invisible to review, to tsc and to eslint. It caught this round's own
  // Download paragraph on 2026-09-08.
  //
  // THE RULE IS NOT RE-STATED HERE. `scripts/check-jsx-spacing.mjs` owns it —
  // verified against next 16.2.11's own SWC binary rather than inferred from
  // rendered pages — and `npm run build:check` runs it over all of `src/`. A
  // second copy of the predicate in this file would be a second thing to get
  // wrong, and a first cut of this leg DID get it wrong: it only looked at text
  // following a close tag, a self-closing tag or an expression, while the real
  // defect does not care what precedes the node at all. So the scanner is
  // EXECUTED, on the three XLAnt files, and this leg exists only to put that
  // 3-second answer in front of a 7-minute `build:check`.
  const script = new URL("./check-jsx-spacing.mjs", import.meta.url).pathname;
  const files = [
    "src/app/internal/xlant/page.tsx",
    "src/app/internal/xlant/devices-list.tsx",
    "src/app/internal/xlant/token-button.tsx",
  ].map((rel) => new URL(`../${rel}`, import.meta.url).pathname);
  try {
    execFileSync(process.execPath, [script, ...files], { stdio: "pipe" });
  } catch (err) {
    // Exit 1 is a defect; exit 2 is "the check could not run" and must NEVER
    // be read as clean — both fail this leg, with the scanner's own words.
    const e = err as { status?: number; stderr?: Buffer; stdout?: Buffer };
    const said = `${e.stderr?.toString() ?? ""}${e.stdout?.toString() ?? ""}`.trim();
    assert.fail(`check-jsx-spacing exited ${e.status ?? "?"}:\n${said}`);
  }
});

await leg("the nginx drop-in caps the device lane below the host default", () => {
  const read = readRepo;
  const dropin = read("deploy/nginx.d/xlant-device.conf");
  // ^~ so the prefix wins over any regex location the stamped conf grows.
  assert.match(dropin, /location \^~ \/api\/xlant\/ \{/);
  assert.match(dropin, /client_max_body_size 2m;/);
  // Everything else must stay identical to the stamped `location /`, or the
  // device lane quietly acquires different proxy behaviour from the rest of
  // the site.
  const site = read("deploy/nginx.conf");
  const block = /location \/ \{([\s\S]*?)\n {4}\}/.exec(site);
  assert.ok(block, "could not find `location /` in deploy/nginx.conf");
  for (const line of block[1]
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)) {
    assert.ok(dropin.includes(line), `drop-in is missing: ${line}`);
  }
  // The host-wide ceiling this exists to narrow.
  assert.match(read("deploy/nginx.d/governance-upload.conf"), /client_max_body_size 110m;/);
});

// ---------------------------------------------------------------------------

relay.close();
rmSync(ROOT, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log("\nall passing");
process.exit(0);
