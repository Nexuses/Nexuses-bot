import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["mongoose", "bcryptjs", "unpdf"],
  experimental: {
    proxyClientMaxBodySize: "12mb",
  },
};

export default nextConfig;
