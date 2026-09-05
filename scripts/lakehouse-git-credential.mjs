#!/usr/bin/env node
/**
 * Git credential helper for the XL Lakehouse git remote (Phase 19).
 *
 * Answers git's `get` action with this app's Lakehouse identity read from the
 * project's own .env at push time:
 *   username = XL_LAKEHOUSE_CLIENT_ID
 *   password = XL_LAKEHOUSE_TOKEN   (the consumer JWT — never the client secret)
 *
 * The token therefore never lands in .git/config, remote URLs, shell profiles,
 * or OS credential stores (`store`/`erase` are deliberate no-ops), and multiple
 * workspaces on one machine stay isolated by project directory — the same
 * pattern as scripts/lakehouse-mcp-headers.mjs.
 *
 * Wired repo-locally by `node scripts/lakehouse-checkpoint.mjs --install`:
 *   git config credential.<lakehouse-base>.helper ''   (clears inherited helpers)
 *   git config --add credential.<lakehouse-base>.helper '!node scripts/lakehouse-git-credential.mjs'
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE = "https://lakehouse.xl.net";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = existsSync(join(scriptDir, "..", ".env"))
  ? join(scriptDir, "..")
  : process.cwd();
const envPath = join(projectRoot, ".env");

function readEnvFile(path) {
  const values = {};
  if (!existsSync(path)) return values;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

const action = process.argv[2];

// Only `get` produces output; `store`/`erase` are silent no-ops so git can
// never persist the long-lived token anywhere.
if (action !== "get") {
  process.exit(0);
}

let requestedHost = null;
try {
  for (const line of readFileSync(0, "utf8").split(/\r?\n/)) {
    const idx = line.indexOf("=");
    if (idx > 0 && line.slice(0, idx) === "host") {
      requestedHost = line.slice(idx + 1).trim();
    }
  }
} catch {
  /* empty stdin is fine */
}

const env = readEnvFile(envPath);
const base = (env.XL_LAKEHOUSE_URL || DEFAULT_BASE).replace(/\/+$/, "");
let lakehouseHost = null;
try {
  lakehouseHost = new URL(base).host;
} catch {
  /* malformed XL_LAKEHOUSE_URL — fall through to the host check below */
}

// Defense in depth: the helper is URL-scoped in .git/config, but never answer
// for a host that is not this project's Lakehouse.
if (requestedHost && lakehouseHost && requestedHost !== lakehouseHost) {
  process.exit(0);
}

const clientId = env.XL_LAKEHOUSE_CLIENT_ID;
const token = env.XL_LAKEHOUSE_TOKEN;

if (!clientId || !token) {
  process.stderr.write(
    "XL Lakehouse git: XL_LAKEHOUSE_CLIENT_ID and XL_LAKEHOUSE_TOKEN must be set in this project's .env. " +
      "Mint a token per the 'Remint XL_LAKEHOUSE_TOKEN' section of the Lakehouse setup document, then retry.\n"
  );
  process.exit(1);
}

process.stdout.write(`username=${clientId}\npassword=${token}\n`);
