import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  trailingSlash: false,
  // @aicompany/core ships TypeScript source (consumed as a git submodule via
  // file: dependency) — Next must transpile it.
  transpilePackages: ["@aicompany/core"],
  // pdf.js resolves its worker via a dynamic import relative to pdf.mjs
  // ("./pdf.worker.mjs"); bundling it into .next/server/chunks breaks that
  // resolution and every PDF extraction throws. Run it from node_modules.
  serverExternalPackages: ["pdfjs-dist"],
  // @aicompany/core's admin blog API (packages/aicompany/src/admin/api/blog.ts,
  // submodule — not editable here) spawns node_modules/.bin/tsx via
  // path.join(process.cwd(), ...), which makes Turbopack's file tracing walk
  // the whole project and warn "Encountered unexpected file in NFT list"
  // (flagged file: next.config.ts). Verified 2026-07-25: the warning is
  // emitted during trace collection, so outputFileTracingExcludes cannot
  // silence it (it only filters the .nft.json output afterwards). NFT output
  // is unused by this deploy model anyway (no `output: "standalone"`; the VM
  // builds in place with full node_modules and runs `next start`), so this
  // build-time-only diagnostic is suppressed with a tightly scoped
  // ignoreIssue. REMOVE once upstream fixes blog.ts (the real fix is a
  // /*turbopackIgnore: true*/ comment on its path.join(process.cwd(), ...)
  // calls) — this ignore would also mask a future whole-project trace
  // introduced by host code, so it must not outlive the upstream bug.
  turbopack: {
    ignoreIssue: [
      {
        path: /next\.config\.ts$/,
        title: "Encountered unexpected file in NFT list",
      },
    ],
  },
  experimental: {
    inlineCss: true,
  },
};

export default nextConfig;
