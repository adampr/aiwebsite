// Synchronous .env loader for the governance tsx scripts. Imported FIRST
// (side-effect import) so process.env is populated before site.config or any
// src/lib module evaluates. Existing process.env values win — the systemd
// units and PM2 spawn env stay authoritative. Top-level-imports-only rule:
// scripts must not lazy-import anything after startup (npm ci wipes
// node_modules under a running job during deploys).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");

try {
  for (const line of fs
    .readFileSync(path.join(repoRoot, ".env"), "utf8")
    .split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined)
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  // .env optional — env may arrive from systemd/PM2.
}

export const REPO_ROOT = repoRoot;
