import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  allowedDevOrigins: (process.env.GMS_ALLOWED_DEV_ORIGINS || "192.168.0.121")
    .split(",").map((origin) => origin.trim()).filter(Boolean),
  env: { NEXT_PUBLIC_GMS_BUILD_ID: process.env.VERCEL_GIT_COMMIT_SHA || "local" },
};

export default nextConfig;
