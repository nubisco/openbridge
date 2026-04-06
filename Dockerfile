# ─── Stage 1: Install all dependencies ───────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /repo

RUN apk add --no-cache python3 make g++
RUN npm install -g pnpm@9

# Copy manifests only — maximise layer cache
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/cli/package.json             apps/cli/
COPY apps/daemon/package.json          apps/daemon/
COPY apps/daemon/scripts/              apps/daemon/scripts/
COPY apps/ui/package.json              apps/ui/
COPY packages/compatibility-homebridge/package.json packages/compatibility-homebridge/
COPY packages/config/package.json      packages/config/
COPY packages/core/package.json        packages/core/
COPY packages/logger/package.json      packages/logger/
COPY packages/sdk/package.json         packages/sdk/

RUN pnpm install --frozen-lockfile

# ─── Stage 2: Build everything ───────────────────────────────────────────────
FROM deps AS build
COPY . .

# Build internal packages first (daemon depends on them)
RUN pnpm --filter @openbridge/core build
RUN pnpm --filter @openbridge/logger build
RUN pnpm --filter @openbridge/config build
RUN pnpm --filter @openbridge/sdk build
RUN pnpm --filter @openbridge/compatibility-homebridge build
# Build UI (served as static files by the daemon)
RUN pnpm --filter @openbridge/ui build
# Build daemon last
RUN pnpm --filter @openbridge/daemon build

# ─── Stage 3: Prune to production-only node_modules ─────────────────────────
FROM build AS prune
RUN pnpm --filter @openbridge/daemon deploy --prod /pruned

# ─── Stage 4: Minimal runtime image ─────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

# Copy production node_modules (workspace deps resolved to real packages)
COPY --from=prune /pruned/node_modules ./apps/daemon/node_modules

# Copy compiled daemon
COPY --from=build /repo/apps/daemon/dist        ./apps/daemon/dist
COPY --from=build /repo/apps/daemon/scripts     ./apps/daemon/scripts
COPY --from=prune /pruned/package.json          ./apps/daemon/package.json

# Copy built UI (served by daemon at ../../../apps/ui/dist relative to dist/)
COPY --from=build /repo/apps/ui/dist            ./apps/ui/dist

# Ensure spawn-helper is executable (node-pty native binary)
RUN find ./apps/daemon/node_modules -name "spawn-helper" -exec chmod +x {} \; 2>/dev/null || true

# Runtime directories
RUN mkdir -p /plugins /root/.openbridge

ENV NODE_ENV=production
ENV OPENBRIDGE_PLUGINS_DIR=/plugins

EXPOSE 8582

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:8582/api/health || exit 1

CMD ["node", "apps/daemon/dist/index.js"]
