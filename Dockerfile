# Ledger Run app (Next.js hub + API + orchestrator). The MCP server lives in the
# same image (src/mcp-server) and can be run standalone with `npm run mcp`; the
# app itself reaches reference data via the in-process DirectMcpClient.
FROM node:20-bookworm-slim AS base
WORKDIR /app
# Prisma's schema + query engines need libssl/openssl at run time; the slim image
# omits it (without this, `prisma db push` and runtime queries fail).
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# --- deps (ALL deps incl. devDeps — the build needs TypeScript/Tailwind; do NOT
#     set NODE_ENV=production here or npm would prune them and break `next build`) ---
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci || npm install

# --- build ---
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

# --- runtime ---
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.mjs ./next.config.mjs
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/src ./src
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/reference-api/sample-invoices ./reference-api/sample-invoices
EXPOSE 3000
CMD ["npm", "run", "start"]
