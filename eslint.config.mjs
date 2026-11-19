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
]);
