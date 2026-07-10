import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  trailingSlash: false,
  // @aicompany/core ships TypeScript source (consumed as a git submodule via
  // file: dependency) — Next must transpile it.
  transpilePackages: ["@aicompany/core"],
  experimental: {
    inlineCss: true,
  },
};

export default nextConfig;
