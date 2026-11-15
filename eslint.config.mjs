import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  // Submodules lint in their own repos; data/ and drizzle/ are generated.
  globalIgnores([
    ".next/**",
    "node_modules/**",
    "packages/**",
    "drizzle/**",
    "data/**",
    "next-env.d.ts",
  ]),
  ...nextVitals,
  ...nextTs,
  // A CommonJS file can only load modules with require(); the TypeScript rule
  // that bans it is written for ES-module sources and is wrong for it.
  // deploy/pm2-drift-check.cjs is RENDERED from the @aicompany/core template
  // pm2-drift-check.cjs.tpl and checked byte for byte by
  // `node packages/aicompany/deploy/render.mjs --check`, so it cannot carry an
  // inline disable as the other rendered .cjs files do (2026-11-15; it was 3
  // of the 8 lint errors). Scoped to that one file on purpose.
  {
    files: ["deploy/pm2-drift-check.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
]);
