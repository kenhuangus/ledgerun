/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // pdf-parse and the Anthropic/MCP SDKs are server-only; keep them external to
  // the server bundle so Next does not try to bundle their native/dynamic bits.
  experimental: {
    serverComponentsExternalPackages: ["pdf-parse", "@prisma/client", "@modelcontextprotocol/sdk"],
  },
};

export default nextConfig;
