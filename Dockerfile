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
RUN pnpm --filter @nubisco/openbridge-core build
RUN pnpm --filter @nubisco/openbridge-logger build
RUN pnpm --filter @nubisco/openbridge-config build
RUN pnpm --filter @nubisco/openbridge-sdk build
RUN pnpm --filter @nubisco/openbridge-compatibility-homebridge build
# Build UI (served as static files by the daemon)
RUN pnpm --filter @nubisco/openbridge-ui build
# Build daemon last
RUN pnpm --filter @nubisco/openbridge-daemon build

# ─── Stage 3: Prune to production-only node_modules ─────────────────────────
FROM build AS prune
RUN pnpm --filter @nubisco/openbridge-daemon deploy --prod /pruned

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

# Entrypoint script (manages volume overlay for self-updates)
COPY apps/daemon/scripts/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Ensure spawn-helper is executable (node-pty native binary)
RUN find ./apps/daemon/node_modules -name "spawn-helper" -exec chmod +x {} \; 2>/dev/null || true

# Runtime directories
RUN mkdir -p /plugins /root/.openbridge /opt/openbridge

ARG APP_VERSION=development
ARG BUILD_HASH=unknown
ENV NODE_ENV=production
ENV OPENBRIDGE_VERSION=$APP_VERSION
ENV OPENBRIDGE_BUILD_HASH=$BUILD_HASH
ENV OPENBRIDGE_PLUGINS_DIR=/plugins

EXPOSE 8581

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:8581/api/health || exit 1

CMD ["/entrypoint.sh"]
