# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: build the Next.js app (standalone) and the Proton SDK bundle
# ---------------------------------------------------------------------------
FROM node:26-trixie-slim AS builder
WORKDIR /app

# No native toolchain needed: SQLite is Node's built-in node:sqlite and sharp
# ships prebuilt libvips. Install scripts stay denied (package.json allowScripts).
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# sdk:check fails the build if package.json, the lockfile and the vendored
# account module disagree about the pinned Proton SDK version.
RUN npm run sdk:check && npm run build

# ---------------------------------------------------------------------------
# Stage 2: runtime
# ---------------------------------------------------------------------------
FROM node:26-trixie-slim AS production
WORKDIR /app

# util-linux: `setpriv` for the PUID/PGID privilege drop (issue #20); wget: the
# healthcheck (a 2 ms wget instead of starting a second Node process every 30 s).
RUN apt-get update && apt-get install -y --no-install-recommends util-linux ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*

# Next.js standalone server + static assets + the one-file Proton SDK bundle.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/dist-proton/runtime.mjs /app/dist-proton/runtime.mjs.LEGAL.txt ./dist-proton/
COPY --from=builder /app/src/server/proton/vendor/UPSTREAM.json ./dist-proton/UPSTREAM.json
# sharp (thumbnails) is loaded by the SDK bundle at runtime, so the tracer can't
# see it: copy it and its prebuilt libvips explicitly.
COPY --from=builder /app/node_modules/sharp ./node_modules/sharp
COPY --from=builder /app/node_modules/@img ./node_modules/@img
COPY --from=builder /app/node_modules/detect-libc ./node_modules/detect-libc
COPY --from=builder /app/node_modules/semver ./node_modules/semver

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Build metadata. APP_VERSION = git sha (diagnostics); IMAGE_TAG = "1.2.3" for a
# release, "1.2.3-preview.<sha>"/"1.2.3-edge.<sha>" otherwise (docs/RELEASING.md);
# SDK_VERSION/SDK_COMMIT label the image (the app reports the values compiled into
# the SDK bundle itself).
ARG APP_VERSION=dev
ARG IMAGE_TAG=dev
ARG APP_RELEASE=dev
ARG SDK_VERSION=unknown
ARG SDK_COMMIT=unknown
ENV APP_VERSION=$APP_VERSION IMAGE_TAG=$IMAGE_TAG
LABEL org.opencontainers.image.title="Proton Drive Backup" \
      org.opencontainers.image.version="$APP_RELEASE" \
      org.opencontainers.image.revision="$APP_VERSION" \
      org.opencontainers.image.source="https://github.com/traktuner/docker-proton-drive-backup" \
      io.github.traktuner.proton-drive-sdk.version="$SDK_VERSION" \
      io.github.traktuner.proton-drive-sdk.commit="$SDK_COMMIT"

# HOME stays on the writable /data volume so a read-only root and a non-root
# `user:` both work. The Proton session lives in PROTON_DRIVE_CACHE_DIR
# (/data/proton/auth-session.json, the same file the CLI-era releases used).
# UV_THREADPOOL_SIZE: parallel stat() on NFS/SMB sources (libuv default is 4).
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DB_PATH=/data/backup.db \
    LOCAL_ROOT=/sources \
    PROTON_DRIVE_CACHE_DIR=/data/proton \
    PROTON_RUNTIME=/app/dist-proton/runtime.mjs \
    UV_THREADPOOL_SIZE=16 \
    CONFIG_DIR=/config \
    HOME=/data/proton

# Only /data is a managed volume; /sources is always supplied by the operator
# (see docker-compose.yml, issue #72). Bake an empty /sources so nested-only
# share mounts have a predictable parent.
RUN mkdir -p /sources
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "server.js"]
