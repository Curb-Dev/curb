# curb-sharer: every mode from one image (keeper, verify, guardian, rebuild).
#
#   docker build -t ghcr.io/<org>/curb-sharer:$(git rev-parse --short HEAD) services/sharer
#
# Node 22 runs the TypeScript sources directly (type stripping): no build
# step, so what runs is exactly what is in the repository at that commit.
# The image runs as the unprivileged `node` user, with a read-only root
# filesystem (docker-compose.yml: read_only + tmpfs), its state in /data,
# tini as PID 1 (signals reach Node; the loop stops after its current tick),
# and a HEALTHCHECK on /healthz for the loop modes.

# node:22-alpine, pinned by digest (Node 22.23.3 when pinned)
ARG NODE_IMAGE=node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# production dependencies only (viem, @openzeppelin/merkle-tree, @noble/hashes),
# exactly as locked; no install scripts run
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM ${NODE_IMAGE}
RUN apk add --no-cache tini \
 && mkdir -p /data \
 && chown node:node /data
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY bin ./bin
ENV NODE_ENV=production \
    CURB_SHARER_DATA=/data \
    CURB_SHARER_HEALTH_PORT=8080 \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD ["node", "/app/bin/healthcheck.mjs"]
ENTRYPOINT ["/sbin/tini", "--", "node", "/app/src/cli.ts"]
CMD ["keeper", "--loop"]
