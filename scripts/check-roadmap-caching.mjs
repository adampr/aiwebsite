#!/usr/bin/env node
// Roadmap caching gate (§5.18, check-jsx-spacing precedent: an invariant
// enforced by a GATE, not review). Company-private pages must be fully
// dynamic and unindexed - a single cached authenticated render is a
// cross-tenant leak, so the rule is structural:
//
//  1. Every page.tsx / layout.tsx under src/app/roadmap and
//     src/app/admin/roadmap must contain `export const dynamic =
//     "force-dynamic"` EXCEPT client components ("use client" - they render
//     inside a dynamic parent) and non-route files.
//  2. NOTHING under src/app/roadmap, src/app/admin/roadmap, or
//     src/app/api/roadmap may export `revalidate` or
//     `generateStaticParams`, or reference revalidatePath /
//     x-prerender-revalidate (revalidation belongs to the public /work lane
//     only).
//  3. src/app/sitemap.ts may reference "roadmap" at most as the single
//     /roadmap teaser entry: the literal "/roadmap/" (a portal child) is
//     banned.
//
// Runs from the pre-commit hook and scripts/check-build-warnings.sh.

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOTS = [
  "src/app/roadmap",
  "src/app/admin/roadmap",
  "src/app/api/roadmap",
];

const failures = [];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name)) yield p;
  }
}

for (const root of ROOTS) {
  if (!existsSync(root)) continue;
  for (const file of walk(root)) {
    const text = readFileSync(file, "utf8");
    const isClient = /^\s*["']use client["']/m.test(text);
    const isRouteFile = /\/(page|layout|route)\.tsx?$/.test(file);
    if (
      isRouteFile &&
      !isClient &&
      !text.includes('export const dynamic = "force-dynamic"')
    ) {
      failures.push(`${file}: missing export const dynamic = "force-dynamic"`);
    }
    if (/export\s+const\s+revalidate/.test(text)) {
      failures.push(`${file}: exports revalidate (banned under roadmap)`);
    }
    if (/generateStaticParams/.test(text)) {
      failures.push(`${file}: generateStaticParams (banned under roadmap)`);
    }
    if (/revalidatePath|x-prerender-revalidate/.test(text)) {
      failures.push(
        `${file}: references revalidation machinery (public /work lane only)`
      );
    }
  }
}

if (existsSync("src/app/sitemap.ts")) {
  const sitemap = readFileSync("src/app/sitemap.ts", "utf8");
  if (sitemap.includes("/roadmap/")) {
    failures.push(
      'src/app/sitemap.ts: contains "/roadmap/" - portal children never enter the sitemap (only the /roadmap teaser may)'
    );
  }
}

if (failures.length > 0) {
  console.error("check-roadmap-caching: FAILED");
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log("check-roadmap-caching: OK");
