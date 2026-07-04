import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  trailingSlash: false,
  experimental: {
    inlineCss: true,
  },
};

export default nextConfig;
