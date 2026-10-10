/**
 * dotenv contract tests.
 *
 *   npm run test:dotenv
 *
 * 17 scripts under scripts/ and drizzle.config.ts start with
 * `import "dotenv/config"` and rely on it to (1) fill process.env from the env
 * file and (2) NOT override a variable the caller already exported (pm2 / the
 * shell win). It also reports (not asserts) where dotenv's own log line goes;
 * measured 2026-10-09: neither 17.4.2 nor 18.0.7 printed one on stdout or
 * stderr from dotenv/config in this setup. This runs
 * `dotenv/config` exactly that way in a child
 * node process against a throw-away fixture file named via
 * DOTENV_CONFIG_PATH (the documented dotenv/config option; no real env file
 * is read, copied or created). Pure, no network. Added by the 2026-10-09
 * dependency-upgrade train (dotenv 17.4.2 -> 18.0.7; per the v18 changelog
 * the log line moved to stderr and dotenv/config is quiet by default).
 */
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = isDeepStrictEqual(actual, expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `\n     got  ${JSON.stringify(actual)}\n     want ${JSON.stringify(expected)}`}`);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dotenv-contract-"));
const fixture = path.join(dir, "contract.fixture");
fs.writeFileSync(
  fixture,
  [
    "CONTRACT_PLAIN=plain-value",
    'CONTRACT_QUOTED="quoted value with spaces"',
    "CONTRACT_PRESET=from-file",
    "# a comment line",
    "CONTRACT_EMPTY=",
    "",
  ].join("\n"),
);

try {
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import "dotenv/config"; process.stdout.write("@@JSON@@" + JSON.stringify({p: process.env.CONTRACT_PLAIN, q: process.env.CONTRACT_QUOTED, pre: process.env.CONTRACT_PRESET, e: process.env.CONTRACT_EMPTY}));',
    ],
    {
      cwd: process.cwd(),
      // A minimal child env on purpose (nothing inherited); cast because Next augments
      // ProcessEnv with a required NODE_ENV the child does not need.
      env: { PATH: process.env.PATH ?? "", DOTENV_CONFIG_PATH: fixture, CONTRACT_PRESET: "from-shell" } as unknown as NodeJS.ProcessEnv,
      encoding: "utf8",
    } satisfies SpawnSyncOptionsWithStringEncoding,
  );
  check("child exits 0", child.status, 0);
  const marker = child.stdout.indexOf("@@JSON@@");
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(child.stdout.slice(marker + 8));
  } catch {
    parsed = { unparseable_stdout: child.stdout };
  }
  // Informational (not asserted): where dotenv's own log line went. v17 prints
  // "[dotenv@...] injecting env" on stdout by default; v18's dotenv/config is quiet.
  const banner = /\[dotenv@/;
  console.log(`info dotenv log line on stdout: ${banner.test(child.stdout.slice(0, Math.max(marker, 0)))}, on stderr: ${banner.test(child.stderr)}`);
  check("values loaded from the file; a pre-exported variable is NOT overridden; quotes and empty values parsed", parsed, {
    p: "plain-value",
    q: "quoted value with spaces",
    pre: "from-shell",
    e: "",
  });
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILED` : "\nall dotenv contract checks passed");
process.exit(failures ? 1 : 0);
