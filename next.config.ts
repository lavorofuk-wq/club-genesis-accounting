import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  env: { NEXT_PUBLIC_GMS_BUILD_ID: process.env.VERCEL_GIT_COMMIT_SHA || "local" },
};

export default nextConfig;
