# ==============================================================================
# Ghita Agent — Sidecar Dockerfile
# ==============================================================================
# Multi-stage build for the Node.js sidecar server.
#
# Build:
#   docker build -t ghita-sidecar .
#
# Run:
#   docker run -p 8080:8080 -e GHITA_SESSION_TOKEN=$(openssl rand -hex 32) ghita-sidecar
# ==============================================================================

# --- Stage 1: Install dependencies ---
FROM node:20-slim AS deps

WORKDIR /app

# Copy root manifests and all workspace packages
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/ ./packages/
COPY apps/ ./apps/
COPY docs/package.json ./docs/

RUN corepack enable pnpm && pnpm install --frozen-lockfile --prod

# --- Stage 2: Build ---
FROM node:20-slim AS build

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/ ./packages/
COPY apps/ ./apps/

RUN corepack enable pnpm && \
    pnpm install --frozen-lockfile && \
    pnpm build:packages

# --- Stage 3: Runtime ---
FROM node:20-slim AS runtime

WORKDIR /app

# Install dumb-init for proper signal handling
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init && \
    rm -rf /var/lib/apt/lists/*

# Copy production node_modules
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages

# Copy built packages and sidecar
COPY --from=build /app/packages/*/dist ./packages/
COPY --from=build /app/apps/desktop/src-tauri/sidecar/ ./apps/desktop/src-tauri/sidecar/

# Create non-root user
RUN groupadd -r ghita && useradd -r -g ghita -d /app -s /sbin/nologin ghita && \
    mkdir -p /app/data && chown -R ghita:ghita /app

USER ghita

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=15s \
  CMD node -e "fetch('http://localhost:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/desktop/src-tauri/sidecar/server.bundle.mjs"]
