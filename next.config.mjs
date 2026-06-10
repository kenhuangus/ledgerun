/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // pdfjs-dist and the Anthropic/MCP SDKs are server-only; keep them external to
  // the server bundle so Next does not try to bundle their native/dynamic bits.
  // pdfjs-dist in particular: bundling it loses the worker (pdf.worker.mjs) and
  // fails at runtime with "Cannot find module /app/.next/server/chunks/pdf.worker.mjs".
  experimental: {
    serverComponentsExternalPackages: [
      "pdfjs-dist",
      "@prisma/client",
      "@modelcontextprotocol/sdk",
      "@anthropic-ai/sdk",
    ],
  },
};

export default nextConfig;
