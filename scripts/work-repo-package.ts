/**
 * Package a git repository into a submission-ready .zip for §5.16 /work.
 *
 *   npx tsx scripts/work-repo-package.ts <repo-path> <out.zip> [--ref HEAD]
 *
 * The bytes come from `git archive <ref>`, never from the working tree: a
 * shared checkout can hold another session's half-built change, and a
 * package is supposed to be the committed project. Everything gitignored
 * (real .env files, node_modules, build output, data/) is therefore absent
 * by construction.
 *
 * On top of that this filter refuses, per file:
 *   - anything whose basename matches the store's own SECRET_FILENAME_PATTERNS
 *     (src/lib/work/secret-patterns.ts, the same list extract.ts refuses a
 *     whole upload over), so a package can never be rejected for carrying a
 *     key file;
 *   - EVERY dotenv-shaped name, `.env.example` and `deploy/site-deploy.env`
 *     included. Those two hold no secrets and the pipeline would accept them;
 *     they are dropped anyway because the instruction here is "no .env files
 *     in the zips", and a template is indistinguishable from the real thing
 *     to anyone reading the archive later;
 *   - any text file whose CONTENT matches SECRET_CONTENT_PATTERNS.
 *
 * Every exclusion is printed with its reason. Paths are reported, matched
 * values never are (the secret-patterns.ts rule).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import {
  fileNameLooksSecret,
  textLooksSecret,
} from "../src/lib/work/secret-patterns";

// `.env`, `.env.anything`, and `anything.env` (deploy/site-deploy.env).
// Deliberately NOT `env.ts` or `environment.json`: a source file whose name
// merely starts with those three letters is code, not a dotenv.
const DOTENV_RE = /^\.env(\..*)?$|\.env$/i;
const TEXT_EXT =
  /\.(md|mdx|markdown|txt|ts|tsx|js|jsx|mjs|cjs|json|ya?ml|toml|ini|cfg|conf|env|sh|bash|zsh|py|rb|go|rs|java|cs|php|sql|html|css|scss|xml|csv|tf|tfvars|properties|gradle|dockerfile|lock)$/i;
const MAX_SCAN_BYTES = 4_000_000;

function die(msg: string): never {
  console.error(`refused: ${msg}`);
  process.exit(2);
}

function walk(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) continue; // never follow, never ship
    if (entry.isDirectory()) out.push(...walk(root, child));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const repo = args[0];
  const out = args[1];
  const refIdx = args.indexOf("--ref");
  const ref = refIdx >= 0 ? args[refIdx + 1] : "HEAD";
  if (!repo || !out) die("usage: work-repo-package.ts <repo-path> <out.zip> [--ref HEAD]");

  const head = spawnSync("git", ["-C", repo, "rev-parse", ref], { encoding: "utf8" });
  if (head.status !== 0) die(`not a git repository or bad ref: ${repo} ${ref}`);
  const commit = head.stdout.trim();

  const tmp = mkdtempSync(path.join(tmpdir(), "work-pkg-"));
  try {
    const tar = spawnSync(
      "bash",
      ["-c", `git -C ${JSON.stringify(repo)} archive --format=tar ${JSON.stringify(ref)} | tar -x -C ${JSON.stringify(tmp)}`],
      { encoding: "utf8", maxBuffer: 1 << 28 }
    );
    if (tar.status !== 0) die(`git archive failed: ${(tar.stderr || "").slice(0, 400)}`);

    const files = walk(tmp).sort();
    const zip = new JSZip();
    const dropped: { path: string; reason: string }[] = [];
    let kept = 0;
    let keptBytes = 0;

    for (const rel of files) {
      const abs = path.join(tmp, rel);
      const base = path.basename(rel);
      if (fileNameLooksSecret(base)) {
        dropped.push({ path: rel, reason: "secret-shaped filename" });
        continue;
      }
      if (DOTENV_RE.test(base)) {
        dropped.push({ path: rel, reason: "dotenv-shaped filename" });
        continue;
      }
      const size = statSync(abs).size;
      const data = readFileSync(abs);
      if (size <= MAX_SCAN_BYTES && (TEXT_EXT.test(base) || !base.includes("."))) {
        const text = data.toString("utf8");
        if (textLooksSecret(text)) {
          dropped.push({ path: rel, reason: "credential shape in content" });
          continue;
        }
      }
      zip.file(rel, data);
      kept++;
      keptBytes += size;
    }

    const bytes = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
    writeFileSync(out, bytes);
    const sha = createHash("sha256").update(bytes).digest("hex");

    console.log(`repo        ${repo}`);
    console.log(`commit      ${commit}`);
    console.log(`out         ${out}`);
    console.log(`entries     ${kept} (from ${files.length} tracked files)`);
    console.log(`raw bytes   ${keptBytes}`);
    console.log(`zip bytes   ${bytes.length}`);
    console.log(`sha256      ${sha}`);
    if (dropped.length) {
      console.log(`excluded    ${dropped.length}`);
      for (const d of dropped) console.log(`  - ${d.path}  (${d.reason})`);
    } else {
      console.log("excluded    0");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
