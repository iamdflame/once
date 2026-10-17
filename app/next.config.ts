import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The host uploads the world bundle into the CreateOS sandbox; ship it with every API function.
  outputFileTracingIncludes: {
    "/api/**/*": ["./world/dist/world.cjs"],
  },
};

export default nextConfig;
