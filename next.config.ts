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
  experimental: {
    inlineCss: true,
  },
};

export default nextConfig;
