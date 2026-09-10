import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["mongoose", "bcryptjs", "unpdf"],
  experimental: {
    proxyClientMaxBodySize: "40mb",
  },
};

export default nextConfig;
