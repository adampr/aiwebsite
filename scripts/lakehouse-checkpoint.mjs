#!/usr/bin/env node
/**
 * XL Lakehouse checkpoint kit (Phase 19) — hands-free git checkpointing.
 *
 * Commits and pushes this workspace's code to its private Lakehouse git remote
 * so work is preserved centrally without relying on human git discipline.
 *
 * Modes (persisted in the committed .lakehouse.json marker):
 *   managed — Lakehouse is this repo's origin-of-record: stage everything,
 *             scan for secrets (quarantine, never abort), commit, push.
 *   mirror  — this repo is Azure-DevOps/gitflow-governed: sync existing
 *             refs to the 'lakehouse' remote only; NEVER create commits.
 *
 * Invariants:
 *   - Pushes ONLY the remote literally named 'lakehouse' — never origin
 *     (pushing origin could fire a consumer app's CI/CD).
 *   - Managed pushes never force; a rejected push falls back to
 *     checkpoint/<host>/<branch> refs so work is never lost or clobbered.
 *   - Secrets never enter history: .gitignore baseline + staged-diff scan
 *     (server-side pre-receive hook is the backstop).
 *   - `--hook` ALWAYS exits 0 (a failing Stop hook must never block Claude).
 *
 * CLI:
 *   node scripts/lakehouse-checkpoint.mjs                # checkpoint now
 *   node scripts/lakehouse-checkpoint.mjs --install [--mode managed|mirror] [--offline-ok]
 *   node scripts/lakehouse-checkpoint.mjs --hook stop|session-start
 *   node scripts/lakehouse-checkpoint.mjs --update       # re-fetch kit scripts
 *
 * Status line (always first stdout line of a checkpoint run):
 *   LAKEHOUSE CHECKPOINT: PUSHED|NOOP|FALLBACK <ref>|QUARANTINED <paths>|AUTH|OFFLINE|SKIPPED <reason>
 * Exit codes: 0 ok (PUSHED/NOOP/FALLBACK/SKIPPED), 1 internal error,
 *   3 AUTH (remint needed), 4 OFFLINE/remote failure, 5 QUARANTINED. Never 2.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const KIT_VERSION = "0.1.0";
const DEFAULT_BASE = "https://lakehouse.xl.net";
const REMOTE_NAME = "lakehouse";
const MARKER_FILE = ".lakehouse.json";
const STATE_DIR = ".lakehouse";
const STATE_FILE = join(STATE_DIR, "state.json");
const ENSURE_PATH = "/api/git/ensure";
const COMMIT_MARKER = "[lakehouse-auto]";
const CHECKPOINT_HOSTED = "/api/auth/checkpoint.mjs";
const CREDENTIAL_HOSTED = "/api/auth/git-credential.mjs";
const CHECKPOINT_PATH = "scripts/lakehouse-checkpoint.mjs";
const CREDENTIAL_PATH = "scripts/lakehouse-git-credential.mjs";
const DEBOUNCE_MS = 30_000;

// ---------------------------------------------------------------------------
// Blocklist — MUST stay identical to src/lib/git/blocklist.ts in lakehouse-app
// (a unit test there asserts these literals appear here).
// ---------------------------------------------------------------------------
const BLOCK_BASENAME_EXCEPTIONS = ["*.example", "*.template", "*.sample"];
const BLOCK_BASENAME_PATTERNS = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.pfx",
  "*.p12",
  "*.keystore",
  "id_rsa*",
  "id_ed25519*",
  "*.db",
  "*.sqlite*",
  ".git-credentials",
];
const BLOCK_PATH_PATTERNS = [
  ".claude/settings.local.json",
  "*/.claude/settings.local.json",
  "secrets/*",
  "*/secrets/*",
  "certs/*",
  "*/certs/*",
];

const GITIGNORE_BASELINE = [
  "# Lakehouse checkpoint kit baseline — secrets must never enter git history",
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.*.example",
  "!.env.template",
  "!.env.sample",
  "*.pem",
  "*.key",
  "*.pfx",
  "*.p12",
  "*.keystore",
  "id_rsa*",
  "id_ed25519*",
  ".git-credentials",
  ".claude/settings.local.json",
  ".lakehouse/",
];

// Staged-diff secret scan: applied to ADDED lines of the staged diff.
const SECRET_LINE_PATTERNS = [
  /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY( BLOCK)?-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprse]-[0-9A-Za-z-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{17,}\.eyJ[A-Za-z0-9_-]{17,}\.[A-Za-z0-9_-]{10,}/,
  /XL_LAKEHOUSE_CLIENT_SECRET\s*[=:]\s*\S{20,}/,
  /\bghp_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
  /\bsk-(ant-)?[A-Za-z0-9_-]{20,}\b/,
];
const ENV_ASSIGNMENT_PATTERN =
  /^(export\s+)?[A-Z][A-Z0-9_]{2,}_(SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*['"]?[A-Za-z0-9+/=_.\-]{16,}/;
const PLACEHOLDER_VALUES = /\$\{|<[a-z-]+>|your-|changeme|xxxx|example|dummy|placeholder/i;

// ---------------------------------------------------------------------------
// Environment / filesystem helpers
// ---------------------------------------------------------------------------
const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = existsSync(join(scriptDir, "..", ".env")) ||
  existsSync(join(scriptDir, "..", "package.json")) ||
  existsSync(join(scriptDir, "..", ".git"))
  ? join(scriptDir, "..")
  : process.cwd();

function readEnvValues() {
  const values = {};
  const path = join(projectRoot, ".env");
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

function baseUrl(env) {
  return (env.XL_LAKEHOUSE_URL || DEFAULT_BASE).replace(/\/+$/, "");
}

function git(args, opts = {}) {
  const res = spawnSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 32 * 1024 * 1024,
    ...opts,
  });
  return {
    status: res.status ?? 1,
    stdout: (res.stdout ?? "").toString(),
    stderr: (res.stderr ?? "").toString(),
  };
}

function gitOk(args) {
  return git(args).status === 0;
}

function gitOut(args) {
  const r = git(args);
  return r.status === 0 ? r.stdout.trim() : null;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readMarker() {
  return readJson(join(projectRoot, MARKER_FILE));
}

function writeMarker(marker) {
  writeFileSync(join(projectRoot, MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`);
}

function readState() {
  return readJson(join(projectRoot, STATE_FILE)) ?? {};
}

function writeState(patch) {
  const state = { ...readState(), ...patch, updatedAt: new Date().toISOString() };
  try {
    mkdirSync(join(projectRoot, STATE_DIR), { recursive: true });
    writeFileSync(join(projectRoot, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    /* state is best-effort */
  }
  return state;
}

// ---------------------------------------------------------------------------
// Blocklist matching (mirrors the server's bash `case` semantics)
// ---------------------------------------------------------------------------
function globToRe(glob, anyDepth) {
  const parts = glob
    .split("*")
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join(anyDepth ? ".*" : "[^/]*")}$`);
}
const blockBasenameExceptionRes = BLOCK_BASENAME_EXCEPTIONS.map((g) => globToRe(g, false));
const blockBasenameRes = BLOCK_BASENAME_PATTERNS.map((g) => globToRe(g, false));
const blockPathRes = BLOCK_PATH_PATTERNS.map((g) => globToRe(g, true));

function isBlockedPath(p) {
  const normalized = p.replace(/^\/+/, "");
  const basename = normalized.split("/").pop() ?? normalized;
  if (blockBasenameExceptionRes.some((re) => re.test(basename))) return false;
  if (blockBasenameRes.some((re) => re.test(basename))) return true;
  return blockPathRes.some((re) => re.test(normalized));
}

// ---------------------------------------------------------------------------
// Mode detection
// ---------------------------------------------------------------------------
function governanceRulesPresent() {
  return (
    existsSync(join(projectRoot, ".cursor/rules/git-branch-governance.mdc")) ||
    existsSync(join(projectRoot, ".cursor/rules/commit-doc-gate.mdc"))
  );
}

function adoOrigin() {
  const url = gitOut(["remote", "get-url", "origin"]);
  return Boolean(url && /dev\.azure\.com|visualstudio\.com/.test(url));
}

function isLakehouseAppItself() {
  const pkg = readJson(join(projectRoot, "package.json"));
  if (pkg?.name === "lakehouse-app") return true;
  const remotes = gitOut(["remote", "-v"]) ?? "";
  return remotes.includes("xl-lakehouse-app");
}

/**
 * Default inference fails safe to mirror on ANY gitflow signal (governance
 * rule files or an ADO origin). Only the rule files are an absolute block:
 * an ADO origin alone allows an explicit `--install --mode managed` opt-in
 * (the checkpoint kit still pushes only 'lakehouse', so ADO CI never fires).
 */
function inferMode() {
  if (adoOrigin() || governanceRulesPresent()) return "mirror";
  return "managed";
}

function resolveMode() {
  const marker = readMarker();
  const mode = marker?.mode === "mirror" || marker?.mode === "managed" ? marker.mode : inferMode();
  // A managed-marked repo that has since gained governance RULES must not
  // auto-commit — refuse and surface, never guess. (An ADO origin alone is
  // not a mismatch: managed there is a deliberate, persisted opt-in.)
  if (mode === "managed" && (governanceRulesPresent() || isLakehouseAppItself())) {
    return { mode, mismatch: true };
  }
  return { mode, mismatch: false };
}

// ---------------------------------------------------------------------------
// Output / exit contract
// ---------------------------------------------------------------------------
let HOOK_MODE = false;

function finish(status, detail, exitCode, extraState = {}) {
  const line = `LAKEHOUSE CHECKPOINT: ${status}${detail ? ` ${detail}` : ""}`;
  writeState({ lastStatus: status, lastDetail: detail ?? null, ...extraState });
  if (!HOOK_MODE || (status !== "NOOP" && status !== "PUSHED")) {
    process.stdout.write(`${line}\n`);
  }
  process.exit(HOOK_MODE ? 0 : exitCode);
}

// ---------------------------------------------------------------------------
// Lakehouse API
// ---------------------------------------------------------------------------
async function callEnsure(env, mode) {
  const token = env.XL_LAKEHOUSE_TOKEN;
  if (!token) return { ok: false, reason: "no_token" };
  try {
    const res = await fetch(`${baseUrl(env)}${ENSURE_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(mode ? { mode } : {}),
    });
    if (res.status === 401) return { ok: false, reason: "auth" };
    if (!res.ok) {
      // Relay the server's own message — an opaque `http_<status>` sends the
      // agent (and the developer) debugging the wrong side. 503 in particular
      // means the Lakehouse HOST is missing git-hosting config: nothing to
      // fix in this app.
      let detail = null;
      try {
        const body = await res.json();
        detail = body?.message ?? body?.error ?? null;
      } catch {
        /* non-JSON error body */
      }
      return {
        ok: false,
        reason: `http_${res.status}`,
        detail: typeof detail === "string" ? detail.slice(0, 300) : null,
      };
    }
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false, reason: "offline" };
  }
}

async function remintToken(env) {
  const { XL_LAKEHOUSE_CLIENT_ID: id, XL_LAKEHOUSE_CLIENT_SECRET: secret } = env;
  if (!id || !secret) return null;
  try {
    const res = await fetch(`${baseUrl(env)}/api/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: id,
        client_secret: secret,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.access_token) return null;
    rewriteEnvToken(data.access_token);
    return data.access_token;
  } catch {
    return null;
  }
}

/** Replace only the XL_LAKEHOUSE_TOKEN line; every other .env line is kept. */
function rewriteEnvToken(token) {
  const path = join(projectRoot, ".env");
  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
  let replaced = false;
  const next = lines.map((line) => {
    if (/^(?:export\s+)?XL_LAKEHOUSE_TOKEN\s*=/.test(line.trim())) {
      replaced = true;
      return `XL_LAKEHOUSE_TOKEN="${token}"`;
    }
    return line;
  });
  if (!replaced) next.push(`XL_LAKEHOUSE_TOKEN="${token}"`);
  writeFileSync(path, next.join("\n"));
}

// ---------------------------------------------------------------------------
// Remote + credential wiring
// ---------------------------------------------------------------------------
function configureCredentialHelper(env) {
  const base = baseUrl(env);
  // Leading empty helper clears inherited OS credential managers for this URL
  // so the eternal token is never persisted outside .env.
  git(["config", "--unset-all", `credential.${base}.helper`]);
  git(["config", `credential.${base}.helper`, ""]);
  git(["config", "--add", `credential.${base}.helper`, `!node ${CREDENTIAL_PATH}`]);
}

function scrubRemoteUrlCredentials() {
  const url = gitOut(["remote", "get-url", REMOTE_NAME]);
  if (url && /:\/\/[^/]*@/.test(url)) {
    git(["remote", "set-url", REMOTE_NAME, url.replace(/:\/\/[^@/]*@/, "://")]);
  }
}

async function ensureRemote(env, mode) {
  const existing = gitOut(["remote", "get-url", REMOTE_NAME]);
  if (existing) {
    scrubRemoteUrlCredentials();
    return { ok: true };
  }
  const ensure = await callEnsure(env, mode);
  if (!ensure.ok) return ensure;
  git(["remote", "add", REMOTE_NAME, ensure.data.repo.remote_url]);
  configureCredentialHelper(env);
  return { ok: true, data: ensure.data };
}

// ---------------------------------------------------------------------------
// .gitignore baseline + untracking
// ---------------------------------------------------------------------------
function enforceGitignoreBaseline() {
  const path = join(projectRoot, ".gitignore");
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = GITIGNORE_BASELINE.filter((l) => !lines.has(l));
  if (missing.length > 0) {
    writeFileSync(path, `${current.replace(/\n*$/, "\n\n")}${missing.join("\n")}\n`);
  }
  // Untrack anything already tracked that matches the blocklist (file kept on disk).
  const tracked = gitOut(["ls-files"])?.split("\n").filter(Boolean) ?? [];
  const untracked = [];
  for (const file of tracked) {
    if (isBlockedPath(file)) {
      if (gitOk(["rm", "--cached", "--quiet", "--", file])) untracked.push(file);
    }
  }
  return untracked;
}

// ---------------------------------------------------------------------------
// Secret scan (staged diff)
// ---------------------------------------------------------------------------
function scanStagedDiff() {
  const diff = git(["diff", "--cached", "-U0", "--no-color"]);
  if (diff.status !== 0) return [];
  const offenders = new Set();
  let currentFile = null;
  for (const line of diff.stdout.split("\n")) {
    const fileMatch = line.match(/^\+\+\+ b\/(.*)$/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      continue;
    }
    if (!line.startsWith("+") || line.startsWith("+++") || !currentFile) continue;
    if (/\.(example|template|sample)$/.test(currentFile)) continue;
    const added = line.slice(1);
    let hit = SECRET_LINE_PATTERNS.some((re) => re.test(added));
    if (!hit && ENV_ASSIGNMENT_PATTERN.test(added.trim()) && !PLACEHOLDER_VALUES.test(added)) {
      hit = true;
    }
    if (!hit && /\blh_[0-9a-f]{24}\b/.test(added) && /secret/i.test(added)) {
      hit = true;
    }
    if (hit) offenders.add(currentFile);
  }
  return [...offenders];
}

// ---------------------------------------------------------------------------
// Push ladder
// ---------------------------------------------------------------------------
function shortHost() {
  return hostname().split(".")[0].toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

function classifyPushFailure(result) {
  const text = `${result.stdout}\n${result.stderr}`;
  if (/401|Authentication failed|could not read Username/i.test(text)) return "auth";
  if (/non-fast-forward|fetch first|\[rejected\]/i.test(text)) return "non_ff";
  return "other";
}

async function pushWithAuthRetry(env, refspecs) {
  let result = git(["push", "--porcelain", REMOTE_NAME, ...refspecs]);
  if (result.status === 0) return { ok: true, result };
  let kind = classifyPushFailure(result);
  if (kind === "auth") {
    const token = await remintToken(env);
    if (token) {
      result = git(["push", "--porcelain", REMOTE_NAME, ...refspecs]);
      if (result.status === 0) return { ok: true, result };
      kind = classifyPushFailure(result);
    } else {
      return { ok: false, kind: "auth", result };
    }
  }
  return { ok: false, kind, result };
}

// ---------------------------------------------------------------------------
// Checkpoint flows
// ---------------------------------------------------------------------------
function workingTreeBusy() {
  const gitDir = gitOut(["rev-parse", "--git-dir"]);
  if (!gitDir) return "not-a-repo";
  const abs = join(projectRoot, gitDir);
  for (const marker of [
    "rebase-merge",
    "rebase-apply",
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
    "index.lock",
  ]) {
    if (existsSync(join(abs, marker))) return marker.toLowerCase().replace(/[_.]/g, "-");
  }
  if ((gitOut(["ls-files", "-u"]) ?? "").length > 0) return "unmerged-index";
  return null;
}

async function checkpointManaged(env, trigger) {
  const branch = gitOut(["symbolic-ref", "--short", "-q", "HEAD"]);
  const detached = !branch;

  // Fast NOOP: clean tree, tracking ref matches, recently checked.
  const state = readState();
  const dirty = (gitOut(["status", "--porcelain"]) ?? "x") !== "";
  if (!dirty && branch) {
    const head = gitOut(["rev-parse", "HEAD"]);
    const remoteRef = gitOut(["rev-parse", `refs/remotes/${REMOTE_NAME}/${branch}`]);
    if (head && head === remoteRef) {
      finish("NOOP", null, 0, { lastRunAt: new Date().toISOString() });
    }
    if (
      state.lastRunAt &&
      Date.now() - Date.parse(state.lastRunAt) < DEBOUNCE_MS &&
      state.lastStatus === "PUSHED"
    ) {
      finish("NOOP", null, 0);
    }
  }

  const untracked = enforceGitignoreBaseline();
  git(["add", "-A"]);

  const quarantined = scanStagedDiff();
  for (const file of quarantined) {
    git(["restore", "--staged", "--", file]);
  }

  const staged = gitOut(["diff", "--cached", "--name-status"]) ?? "";
  const stagedFiles = staged.split("\n").filter(Boolean);

  if (stagedFiles.length > 0) {
    const summary =
      stagedFiles.length === 1
        ? stagedFiles[0].split("\t").pop()
        : `${stagedFiles.length} files changed`;
    const bodyLines = stagedFiles.slice(0, 20).map((l) => l.replace("\t", " "));
    if (stagedFiles.length > 20) bodyLines.push(`… and ${stagedFiles.length - 20} more`);
    const marker = readMarker();
    const identityArgs = [];
    if (!gitOut(["config", "user.email"])) {
      identityArgs.push(
        "-c",
        `user.name=${process.env.USER ?? "dev"} via lakehouse-kit`,
        "-c",
        `user.email=${marker?.ownerEmail || "lakehouse@xl.net"}`
      );
    }
    const message = [
      `checkpoint(${shortHost()}): ${summary} ${COMMIT_MARKER}`,
      "",
      ...bodyLines,
      "",
      `Lakehouse-Kit: v${KIT_VERSION}`,
      `Lakehouse-Trigger: ${trigger}`,
    ].join("\n");
    const commit = git([...identityArgs, "commit", "--quiet", "-m", message]);
    if (commit.status !== 0) {
      finish("SKIPPED", `commit-failed: ${commit.stderr.trim().slice(0, 200)}`, 1);
    }
  }

  // Anything to push?
  const remote = await ensureRemote(env, "managed");
  if (!remote.ok) {
    if (remote.reason === "auth" || remote.reason === "no_token") {
      finish("AUTH", null, 3, { lastError: "ensure_auth" });
    }
    finish("OFFLINE", remote.detail ?? `ensure-${remote.reason}`, 4);
  }

  const pushBranch = detached ? null : branch;
  const head = gitOut(["rev-parse", "HEAD"]);
  if (!head) finish("SKIPPED", "empty-repo", 0);

  const targetRef = pushBranch
    ? `refs/heads/${pushBranch}`
    : `refs/heads/checkpoint/${shortHost()}/detached-${head.slice(0, 8)}`;

  const attempt = await pushWithAuthRetry(env, [`HEAD:${targetRef}`]);
  if (attempt.ok) {
    if (quarantined.length > 0) {
      finish("QUARANTINED", quarantined.join(","), 5, {
        quarantined,
        lastPushAt: new Date().toISOString(),
        lastRunAt: new Date().toISOString(),
      });
    }
    finish("PUSHED", null, 0, {
      quarantined: [],
      lastPushAt: new Date().toISOString(),
      lastRunAt: new Date().toISOString(),
      lastError: null,
      untrackedBlocked: untracked,
    });
  }

  if (attempt.kind === "auth") finish("AUTH", null, 3, { lastError: "push_auth" });

  if (attempt.kind === "non_ff" && pushBranch) {
    // Never force: land the work on a per-host checkpoint ref instead.
    const fallback = `refs/heads/checkpoint/${shortHost()}/${pushBranch}`;
    let rescue = await pushWithAuthRetry(env, [`HEAD:${fallback}`]);
    if (!rescue.ok && rescue.kind === "non_ff") {
      const stamped = `${fallback}-${new Date().toISOString().replace(/[-:]|\.\d+/g, "").replace("T", "t").slice(0, 16)}`;
      rescue = await pushWithAuthRetry(env, [`HEAD:${stamped}`]);
      if (rescue.ok) finish("FALLBACK", stamped, 0, { lastPushAt: new Date().toISOString() });
    }
    if (rescue.ok) finish("FALLBACK", fallback, 0, { lastPushAt: new Date().toISOString() });
  }

  const detail = attempt.result.stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 300);
  finish("OFFLINE", detail || "push-failed", 4, { lastError: detail });
}

async function checkpointMirror(env, _trigger) {
  const remote = await ensureRemote(env, "mirror");
  if (!remote.ok) {
    if (remote.reason === "auth" || remote.reason === "no_token") finish("AUTH", null, 3);
    finish("OFFLINE", remote.detail ?? `ensure-${remote.reason}`, 4);
  }
  // Forced refspecs are the sanctioned mirror mechanism: the Lakehouse copy is
  // a pure reflection of this repo, and ADO-side rebases must re-mirror. No
  // --prune and no delete refspecs — deletions never propagate.
  const attempt = await pushWithAuthRetry(env, [
    "+refs/heads/*:refs/heads/*",
    "+refs/tags/*:refs/tags/*",
  ]);
  if (attempt.ok) {
    const changed = attempt.result.stdout
      .split("\n")
      .filter((l) => /^[*+ ]\t/.test(l) && !l.includes("[up to date]")).length;
    finish(changed > 0 ? "PUSHED" : "NOOP", null, 0, {
      lastPushAt: new Date().toISOString(),
      lastRunAt: new Date().toISOString(),
    });
  }
  if (attempt.kind === "auth") finish("AUTH", null, 3);
  const rejected = attempt.result.stdout
    .split("\n")
    .filter((l) => l.startsWith("!"))
    .map((l) => l.split("\t")[1])
    .filter(Boolean);
  finish(
    "OFFLINE",
    rejected.length ? `refs-rejected: ${rejected.join(",")}` : "push-failed",
    4,
    { lastError: attempt.result.stderr.trim().slice(0, 300) }
  );
}

async function runCheckpoint(trigger) {
  const env = readEnvValues();
  const busy = workingTreeBusy();
  if (busy === "not-a-repo") finish("SKIPPED", "not-a-git-repo", 0);

  const { mode, mismatch } = resolveMode();
  if (mode === "mirror") {
    // Mirror never touches the working tree, so busy states don't matter.
    await checkpointMirror(env, trigger);
    return;
  }
  if (mismatch) {
    finish("SKIPPED", "mode-mismatch (managed marker but gitflow governance detected — run --install --mode mirror or ask the developer)", 0, {
      lastError: "mode-mismatch",
    });
  }
  if (busy) finish("SKIPPED", `busy-${busy}`, 0);
  await checkpointManaged(env, trigger);
}

// ---------------------------------------------------------------------------
// Hooks merge (.claude/settings.json)
// ---------------------------------------------------------------------------
function hooksBlock() {
  return {
    Stop: [
      {
        hooks: [
          {
            type: "command",
            command: `node ${CHECKPOINT_PATH} --hook stop || true`,
            timeout: 120,
          },
        ],
      },
    ],
    SessionStart: [
      {
        matcher: "startup|resume",
        hooks: [
          {
            type: "command",
            command: `node ${CHECKPOINT_PATH} --hook session-start || true`,
            timeout: 30,
          },
        ],
      },
    ],
  };
}

function mergeHooks() {
  const settingsPath = join(projectRoot, ".claude", "settings.json");
  mkdirSync(join(projectRoot, ".claude"), { recursive: true });
  let settings = {};
  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, "utf8");
    if (raw.trim()) {
      try {
        settings = JSON.parse(raw);
      } catch {
        throw new Error(
          `.claude/settings.json is not valid JSON — refusing to modify it. Fix it, then re-run --install.`
        );
      }
      if (!existsSync(`${settingsPath}.bak`)) copyFileSync(settingsPath, `${settingsPath}.bak`);
    }
  }
  settings.hooks = settings.hooks ?? {};
  for (const [event, entries] of Object.entries(hooksBlock())) {
    const existing = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const idx = existing.findIndex((entry) =>
      (entry?.hooks ?? []).some((h) => String(h?.command ?? "").includes("lakehouse-checkpoint.mjs"))
    );
    if (idx >= 0) existing[idx] = entries[0];
    else existing.push(entries[0]);
    settings.hooks[event] = existing;
  }
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Install / update
// ---------------------------------------------------------------------------
async function install(args) {
  const env = readEnvValues();
  const modeFlagIdx = args.indexOf("--mode");
  const modeFlag = modeFlagIdx >= 0 ? args[modeFlagIdx + 1] : null;
  const offlineOk = args.includes("--offline-ok");

  if (modeFlag && !["managed", "mirror"].includes(modeFlag)) {
    throw new Error(`--mode must be managed or mirror (got '${modeFlag}')`);
  }

  if (isLakehouseAppItself() && modeFlag !== "mirror") {
    throw new Error(
      "Refusing to install in the Lakehouse app workspace itself except as an explicit mirror (--mode mirror). Managed auto-commits would violate its gitflow governance."
    );
  }

  let mode = modeFlag ?? readMarker()?.mode ?? inferMode();
  if (mode === "managed" && governanceRulesPresent()) {
    throw new Error(
      "This repo carries gitflow governance rules (.cursor/rules/git-branch-governance.mdc or commit-doc-gate.mdc) — managed mode (auto-commit) would violate them. Re-run with --mode mirror."
    );
  }
  if (mode === "managed" && adoOrigin() && modeFlag !== "managed") {
    throw new Error(
      "This repo has an Azure DevOps origin, so mirror is the safe default. To make Lakehouse the origin-of-record anyway (auto-commit; the kit never pushes origin), the developer must opt in explicitly: --install --mode managed."
    );
  }
  if (mode === "managed" && adoOrigin()) {
    process.stdout.write(
      "NOTE: managed mode on an ADO-origin repo — the kit auto-commits locally and pushes ONLY the 'lakehouse' remote; the ADO origin only moves when a human pushes it (its CI cannot be triggered by checkpoints).\n"
    );
  }

  if (!gitOut(["rev-parse", "--git-dir"])) {
    if (mode === "mirror") {
      throw new Error("Mirror mode needs an existing git repo (nothing to mirror). ");
    }
    const init = git(["init", "-b", "main"]);
    if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
    process.stdout.write("Initialized empty git repository (branch: main)\n");
  }

  const untracked = enforceGitignoreBaseline();
  if (untracked.length) {
    process.stdout.write(`Untracked blocked files (kept on disk): ${untracked.join(", ")}\n`);
  }

  let ownerEmail = readMarker()?.ownerEmail ?? null;
  const ensure = await callEnsure(env, mode);
  if (ensure.ok) {
    ownerEmail = ensure.data.owner_email ?? ownerEmail;
    const existing = gitOut(["remote", "get-url", REMOTE_NAME]);
    if (!existing) {
      git(["remote", "add", REMOTE_NAME, ensure.data.repo.remote_url]);
    } else if (existing !== ensure.data.repo.remote_url) {
      git(["remote", "set-url", REMOTE_NAME, ensure.data.repo.remote_url]);
    }
    configureCredentialHelper(env);
    if (ensure.data.warning) process.stdout.write(`NOTE: ${ensure.data.warning}\n`);
    if (ensure.data.latest_kit_version && ensure.data.latest_kit_version !== KIT_VERSION) {
      process.stdout.write(`KIT OUTDATED: v${KIT_VERSION} installed, v${ensure.data.latest_kit_version} available — run --update\n`);
    }
  } else if (!offlineOk) {
    throw new Error(
      ensure.reason === "no_token" || ensure.reason === "auth"
        ? "No usable XL_LAKEHOUSE_TOKEN in .env — complete Lakehouse First-Time Setup (or remint), then re-run --install. Use --offline-ok to defer the remote wiring."
        : ensure.detail ?? `Lakehouse unreachable (${ensure.reason}) — retry when online, or use --offline-ok.`
    );
  } else {
    process.stdout.write("Offline install: remote wiring deferred to the first authenticated checkpoint run.\n");
  }

  writeMarker({
    kitVersion: KIT_VERSION,
    mode,
    remote: REMOTE_NAME,
    ...(ownerEmail ? { ownerEmail } : {}),
  });

  mergeHooks();

  process.stdout.write(
    [
      `LAKEHOUSE KIT INSTALLED (v${KIT_VERSION}, mode: ${mode})`,
      `- Marker: ${MARKER_FILE} (committed) · hooks merged into .claude/settings.json`,
      "- Restart Claude Code once so the Stop/SessionStart hooks load.",
      `- Run 'node ${CHECKPOINT_PATH}' now and confirm the first line reads PUSHED (or NOOP).`,
      "",
    ].join("\n")
  );
}

async function update() {
  const env = readEnvValues();
  const base = baseUrl(env);
  for (const [hosted, local] of [
    [CHECKPOINT_HOSTED, CHECKPOINT_PATH],
    [CREDENTIAL_HOSTED, CREDENTIAL_PATH],
  ]) {
    const res = await fetch(`${base}${hosted}`);
    if (!res.ok) throw new Error(`Failed to fetch ${base}${hosted}: HTTP ${res.status}`);
    mkdirSync(join(projectRoot, "scripts"), { recursive: true });
    writeFileSync(join(projectRoot, local), await res.text());
  }
  process.stdout.write("Kit scripts updated — re-running install...\n");
  const rerun = spawnSync(process.execPath, [join(projectRoot, CHECKPOINT_PATH), "--install"], {
    cwd: projectRoot,
    stdio: "inherit",
  });
  process.exit(rerun.status ?? 0);
}

// ---------------------------------------------------------------------------
// SessionStart context — reads only local state; prints ONLY when the agent
// must act (stdout becomes agent context in Claude Code).
// ---------------------------------------------------------------------------
function sessionStartContext() {
  const state = readState();
  const messages = [];
  if (state.lastStatus === "AUTH") {
    messages.push(
      "Last Lakehouse checkpoint failed with AUTH: remint XL_LAKEHOUSE_TOKEN per the 'Remint XL_LAKEHOUSE_TOKEN' section of the xl-lakehouse rule, then run: node scripts/lakehouse-checkpoint.mjs"
    );
  }
  if (state.lastStatus === "OFFLINE") {
    messages.push(
      `Last Lakehouse checkpoint failed (${state.lastDetail ?? "remote error"}): run 'node scripts/lakehouse-checkpoint.mjs' and report its status line to the developer if it fails again.`
    );
  }
  if (Array.isArray(state.quarantined) && state.quarantined.length > 0) {
    messages.push(
      `Lakehouse checkpoint quarantined secret-like files (NOT committed): ${state.quarantined.join(", ")}. Review with the developer; never bypass the scan.`
    );
  }
  const { mismatch } = resolveMode();
  if (mismatch) {
    messages.push(
      "Lakehouse kit mode mismatch: .lakehouse.json says managed but this repo now has gitflow governance / an ADO origin. Auto-commits are suspended — confirm with the developer, then run: node scripts/lakehouse-checkpoint.mjs --install --mode mirror"
    );
  }
  if (messages.length > 0) {
    process.stdout.write(`${messages.join("\n")}\n`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);

  if (args[0] === "--hook") {
    HOOK_MODE = true;
    if (args[1] === "session-start") {
      sessionStartContext();
      return;
    }
    await runCheckpoint("stop-hook");
    return;
  }
  if (args[0] === "--install") {
    await install(args);
    return;
  }
  if (args[0] === "--update") {
    await update();
    return;
  }
  await runCheckpoint(args[0] === "--session-start" ? "session-start" : "manual");
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  if (!HOOK_MODE) process.stdout.write(`LAKEHOUSE CHECKPOINT: SKIPPED error\n`);
  writeState({ lastStatus: "ERROR", lastError: message });
  process.exit(HOOK_MODE ? 0 : 1);
});
