#!/usr/bin/env node
// Guards against the SWC "glued text" defect, which has now shipped twice.
//
// THE RULE (verified 2026-07-29 against next 16.2.11's own SWC binary via
// transformSync, not inferred from rendered pages):
//
//   A JSX text node loses ALL of its leading horizontal whitespace if and only
//   if the node contains a newline AND contains a decodable HTML entity
//   (&name;, &#decimal;, or &#xHEX;).
//
// It does not matter what precedes the text: a close tag, a self-closing
// element, and a {expression} all behave identically. Trailing whitespace is
// never affected, and a single-line node keeps its space. So this ships joined:
//
//   <a href="#x">Follow-Up Emails</a> lands its draft in the
//   rep&apos;s own Gmail.                          -> "Follow-Up Emailslands"
//
// while the same two lines without the &apos; render correctly, which is why
// only some links are affected and why review keeps missing it.
//
// THE FIX is an explicit separator at the boundary:
//
//   <a href="#x">Follow-Up Emails</a>{" "}
//   lands its draft in the rep&apos;s own Gmail.
//
// Usage:
//   node scripts/check-jsx-spacing.mjs                 # scan host src/ (gating)
//   node scripts/check-jsx-spacing.mjs a.tsx b.tsx     # scan given files
//   node scripts/check-jsx-spacing.mjs --staged        # scan staged blobs (hook)
//   node scripts/check-jsx-spacing.mjs --module        # also report packages/aicompany
//
// Exit codes: 0 clean · 1 defect found in gated files · 2 the check itself
// could not run (never treat 2 as clean). Module findings are reported but do
// not gate, because that code is fixed in the @aicompany/core repo, not here.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const ENTITY = /&(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#[xX][0-9a-fA-F]+);/;
// A boundary is anything that can precede a text node and render beside it:
// a close tag, a self-closing element, or the end of a {expression}.
const BOUNDARY = /(?:<\/[A-Za-z][\w.]*>|\/>|\})([ \t]+)([^<{]*)/g;

const MODULE_ROOT = "packages/aicompany/src";

function collect(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) collect(path, out);
    else if (name.endsWith(".tsx")) out.push(path);
  }
  return out;
}

// NOTE ON COMMENTS AND STRINGS: this deliberately does NOT try to blank out JS
// string literals first. JSX text that contains &apos; also contains a bare
// apostrophe, so a naive tokenizer treats the entity itself as a string opener
// and blinds the scan to exactly the defect it exists to catch (that bug was
// found in review of this file). A stray hit inside a comment or an HTML string
// is a visible, bypassable false positive; a missed &apos; is a shipped defect.

function scanSource(src, label) {
  const found = [];
  for (const m of src.matchAll(BOUNDARY)) {
    const gapStart = m.index + m[0].indexOf(m[1]);
    const textStart = gapStart + m[1].length;
    const rest = src.slice(textStart);
    const end = rest.search(/[<{]/);
    const node = end === -1 ? rest : rest.slice(0, end);
    if (!node.includes("\n")) continue; // single-line nodes keep their space
    if (!ENTITY.test(node)) continue; // no entity, no defect
    if (!node.trim()) continue; // whitespace-only node
    const line = src.slice(0, textStart).split("\n").length;
    found.push({
      file: label,
      line,
      text: node.replace(/\s+/g, " ").trim().slice(0, 64),
    });
  }
  return found;
}

function stagedTsxFiles() {
  const out = execFileSync(
    "git",
    ["diff", "--cached", "-z", "--name-only", "--diff-filter=ACMR"],
    { encoding: "utf8" },
  );
  return out.split("\0").filter((f) => f.endsWith(".tsx"));
}

function readStaged(file) {
  return execFileSync("git", ["show", `:${file}`], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

let hostFindings = [];
let moduleFindings = [];

try {
  const argv = process.argv.slice(2);
  const staged = argv.includes("--staged");
  const withModule = argv.includes("--module");
  const explicit = argv.filter((a) => a.endsWith(".tsx"));

  if (staged) {
    // Read the INDEX, not the worktree: those diverge under `git add -p` and
    // "stage, then keep editing", and the gate must judge what is committed.
    for (const file of stagedTsxFiles()) {
      const src = readStaged(file);
      const hits = scanSource(src, file);
      if (file.startsWith(MODULE_ROOT)) moduleFindings.push(...hits);
      else hostFindings.push(...hits);
    }
  } else {
    const files = explicit.length ? explicit : collect("src");
    for (const file of files) {
      const hits = scanSource(readFileSync(file, "utf8"), file);
      if (file.startsWith(MODULE_ROOT)) moduleFindings.push(...hits);
      else hostFindings.push(...hits);
    }
    if (withModule && !explicit.length) {
      for (const file of collect(MODULE_ROOT)) {
        moduleFindings.push(...scanSource(readFileSync(file, "utf8"), file));
      }
    }
  }
} catch (err) {
  console.error(`jsx-spacing: check could not run: ${err.message}`);
  process.exit(2); // never silently pass
}

if (moduleFindings.length) {
  console.error(
    "\njsx-spacing: glued text in @aicompany/core (fix upstream in that repo, not here):",
  );
  for (const f of moduleFindings) {
    console.error(`  ${f.file}:${f.line}  ...${f.text}`);
  }
}

if (hostFindings.length) {
  console.error("\nBLOCKED: JSX text glued to what precedes it (SWC entity defect).\n");
  for (const f of hostFindings) {
    console.error(`  ${f.file}:${f.line}  ...${f.text}`);
  }
  console.error(
    "\n  A JSX text node that contains BOTH a newline AND an HTML entity loses\n" +
      "  its leading space at build time, so the previous word ships joined to\n" +
      "  it. Add an explicit separator at the boundary:\n" +
      '\n      <a href="#x">Name</a>{" "}\n      lands in the rep&apos;s Gmail\n',
  );
  process.exit(1);
}

console.log(
  `jsx-spacing: clean${moduleFindings.length ? ` (${moduleFindings.length} upstream finding(s) reported above)` : ""}`,
);
