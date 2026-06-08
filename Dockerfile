# Ledger Run app (Next.js hub + API + orchestrator + MCP server).
# Single image; the compose file runs it as both the `app` and `mcp-server`
# services with different commands.
FROM node:20-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# --- deps ---
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
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.mjs ./next.config.mjs
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/src ./src
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/reference-api/sample-invoices ./reference-api/sample-invoices
EXPOSE 3000 7000
CMD ["npm", "run", "start"]
