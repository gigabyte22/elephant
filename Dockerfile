# Elephant memory service. The backend runs from TypeScript source via tsx (no
# compile step); the dashboard is built into web/dist and served by the API.
#
#   docker build -t elephant .
#   docker compose --profile app up -d     # service + Neo4j, config from .env
#
# On start the container applies the schema migration (idempotent) and then
# serves on MEMORY_PORT.

FROM node:22-slim AS base
WORKDIR /app
RUN corepack enable

# The dashboard bundle. Its toolchain (vite, react) stays in this stage.
FROM base AS web
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @elephant/web build

# Only the service's own dependencies. tsx is a devDependency and runs the
# service, so dev dependencies are installed too.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/client/package.json packages/client/
COPY web/package.json web/
COPY adapters/mcp/package.json adapters/mcp/
COPY adapters/openclaw/package.json adapters/openclaw/
RUN pnpm install --frozen-lockfile --filter elephant

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    MEMORY_BIND=0.0.0.0 \
    KNOWLEDGE_BLOB_DIR=/data/knowledge-blobs \
    OKF_DIR=/data/okf-vault

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json tsconfig.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --from=web --chown=node:node /app/web/dist ./web/dist

RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node

EXPOSE 18790
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MEMORY_PORT||18790)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["sh", "-c", "node_modules/.bin/tsx scripts/migrate.ts && exec node_modules/.bin/tsx scripts/serve.ts"]
