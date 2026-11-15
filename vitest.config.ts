// Host-side vitest, for the ONE test that needs module mocking
// (scripts/blog-audio-fallback.test.ts: the article-audio backup voice through
// the module's real failover, with its database and encoder peers mocked).
// Every other host test is a self-checking tsx script (`npm run test:*`).
// `@/` mirrors tsconfig.json `paths`, because site.config.ts imports "@/lib/...".
// The module's own suite runs from packages/aicompany with its own config.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [{ find: /^@\/(.*)$/, replacement: fileURLToPath(new URL("./src/$1", import.meta.url)) }],
  },
  test: {
    include: ["scripts/blog-audio-fallback.test.ts"],
    environment: "node",
    fileParallelism: false,
  },
});
