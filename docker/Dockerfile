# syntax=docker/dockerfile:1.7
#
# The Surface image (SPEC-004 §5): server, built web app, the `surface` CLI and
# pg_dump/pg_restore 17. Runs as uid 10001 and works with a read-only root
# filesystem as long as /data and /tmp are writable. Build from the repository root:
#
#   docker build -f docker/Dockerfile -t surface:local .
#
# Every stage runs on the target platform, so native production dependencies
# (none yet; argon2 arrives with PLAN-001) are installed for the right CPU.

ARG NODE_IMAGE=node:24-bookworm-slim

# ---------------------------------------------------------------------------
# deps: download every package once. Only the lockfile invalidates this layer.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    npm_config_store_dir=/pnpm/store \
    TURBO_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=surface-pnpm-store,target=/pnpm/store \
    pnpm fetch --frozen-lockfile

# ---------------------------------------------------------------------------
# build: compile the server and web app, then bundle the server with only its
# production dependencies into /out.
# ---------------------------------------------------------------------------
FROM deps AS build
COPY . .
RUN --mount=type=cache,id=surface-pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile
RUN pnpm turbo run build --filter=@surface/server --filter=@surface/web
# --legacy: deploy without switching the whole workspace to injected packages.
RUN --mount=type=cache,id=surface-pnpm-store,target=/pnpm/store \
    pnpm --filter @surface/server deploy --legacy --prod /out \
 && cp -R apps/web/dist /out/web \
 && cp docker/healthcheck.js /out/bin/healthcheck.js

# ---------------------------------------------------------------------------
# pgdg-key: the PostgreSQL apt repository key, trusted only if its fingerprint
# matches (https://www.postgresql.org/download/linux/debian/). Not in the image.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS pgdg-key
ARG PGDG_KEY_FINGERPRINT=B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg; \
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /tmp/pgdg.asc; \
    actual=$(gpg --show-keys --with-colons /tmp/pgdg.asc | awk -F: '/^fpr:/ { print $10; exit }'); \
    test "$actual" = "$PGDG_KEY_FINGERPRINT"; \
    gpg --dearmor -o /pgdg.gpg /tmp/pgdg.asc

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ARG PG_MAJOR=17
COPY --from=pgdg-key /pgdg.gpg /usr/share/keyrings/pgdg.gpg
# pg_dump/pg_restore must match the server's major version (PLAN-004 risks), and
# Debian bookworm ships 15, so they come from the PostgreSQL apt repository.
# npm, corepack and yarn are removed: not needed at runtime, less to patch.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates; \
    . /etc/os-release; \
    echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends "postgresql-client-${PG_MAJOR}" tini; \
    rm -rf /var/lib/apt/lists/*; \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*; \
    useradd --uid 10001 --user-group --no-create-home --home-dir /nonexistent \
            --shell /usr/sbin/nologin surface

# Application files belong to root, so the running process cannot modify them.
COPY --from=build /out /app
RUN ln -s /app/bin/surface.js /usr/local/bin/surface \
 && mkdir -p /data/uploads /data/backups \
 && chown -R 10001:10001 /data

ARG SURFACE_VERSION=0.0.0
ARG SURFACE_COMMIT=dev
ARG SURFACE_SOURCE=https://github.com/s-ayush/surface
LABEL org.opencontainers.image.title="Surface" \
      org.opencontainers.image.description="Self-hosted, keyboard-first issue tracker" \
      org.opencontainers.image.version="${SURFACE_VERSION}" \
      org.opencontainers.image.revision="${SURFACE_COMMIT}" \
      org.opencontainers.image.source="${SURFACE_SOURCE}"

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    SURFACE_WEB_DIR=/app/web \
    SURFACE_COMMIT=${SURFACE_COMMIT}

# uploads/ and backups/ are named volumes in compose; /data itself stays writable
# under a read-only root filesystem (AC-4).
VOLUME ["/data"]
USER 10001:10001
WORKDIR /app
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD ["node", "/app/bin/healthcheck.js"]
ENTRYPOINT ["tini", "--", "node", "/app/bin/surface.js"]
CMD ["serve"]
