# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: Build the Next.js app (standalone output)
# ---------------------------------------------------------------------------
FROM node:26-bookworm AS builder
WORKDIR /app

# Native build deps for better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Install deps first (cached unless package.json/lock change). The npm cache
# mount keeps downloads warm across builds even when the layer is invalidated.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: Download the official proton-drive CLI binary
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS cli
# Keep these in sync via .github/workflows/check-cli-update.yml
ARG PROTON_CLI_VERSION=0.9.0
ARG PROTON_CLI_SHA512_X64=3533025ba69ae112b64e3e01fbcc1ad0688136a4043f6cf6a72886967d85fdcd9ec235479c2e113171614be5225bfba93427509a05ca5aa6071d924fa7e91ca8
ARG PROTON_CLI_SHA512_ARM64=c8d5a6b174e57f06d05cb5483400b9963faf58e743b6b33706bb73ecff718047ffce6b439994255b94b5b226b90d2e91bef7418ec96c1c3f5d8bf39b6cd01321
WORKDIR /tmp
RUN apt-get update && apt-get install -y --no-install-recommends wget ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    case "$(uname -m)" in \
      x86_64)  A=linux-x64;   EXPECT="$PROTON_CLI_SHA512_X64" ;; \
      aarch64) A=linux-arm64; EXPECT="$PROTON_CLI_SHA512_ARM64" ;; \
      *) echo "Unsupported arch: $(uname -m)" >&2; exit 1 ;; \
    esac; \
    wget --tries=3 --timeout=30 \
      "https://proton.me/download/drive/cli/${PROTON_CLI_VERSION}/${A}/proton-drive" \
      -O /usr/local/bin/proton-drive; \
    # Verify integrity against the pinned checksum (Proton publishes none).
    echo "${EXPECT}  /usr/local/bin/proton-drive" | sha512sum -c -; \
    chmod +x /usr/local/bin/proton-drive; \
    test -x /usr/local/bin/proton-drive

# ---------------------------------------------------------------------------
# Stage 3: Runtime
# ---------------------------------------------------------------------------
FROM node:26-bookworm-slim AS runtime
WORKDIR /app

# Build metadata shown in the app footer. APP_VERSION = git sha (used for the
# container update check); IMAGE_TAG = friendly "<cliVersion>-<revision>".
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
ARG IMAGE_TAG=dev
ENV IMAGE_TAG=$IMAGE_TAG

# libsecret is linked by the CLI but never used (we force the file-based secret
# store); ca-certificates for TLS; wget for the healthcheck; util-linux for
# `setpriv` (PUID/PGID drop — issue #20); iproute2 for `tc`/`ip` (opt-in upload
# speed limit — issue #23, only active with cap_add: NET_ADMIN).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libsecret-1-0 wget util-linux iproute2 \
    && rm -rf /var/lib/apt/lists/*

# Next.js standalone server + static assets
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# Next 16's tracer over-includes the repo into the standalone output; drop the
# source/config files that aren't needed at runtime (keeps source out of the image).
RUN rm -rf src sdk-worker Dockerfile README.md docker-compose.yml docker-entrypoint.sh \
    tsconfig.json package-lock.json postcss.config.mjs .dockerignore

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# HOME is pinned to the writable, persistent /data volume (NOT the nonexistent
# /home/app): so a read-only root filesystem AND a non-root `user:` both work — any
# stray dotfile the CLI/deps write stays off the read-only root. The Proton session
# lives in PROTON_DRIVE_CACHE_DIR (same dir), so this only relocates incidental
# HOME writes; it is not the session store.
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DB_PATH=/data/backup.db \
    LOCAL_ROOT=/sources \
    PROTON_DRIVE_LOG_LEVEL=ERROR \
    CONFIG_DIR=/config \
    HOME=/data/proton

# Only /data is a managed volume. /sources is always supplied by the operator,
# either as (a) one parent bind (e.g. ./sources:/sources:ro — keep it rw if you
# nest per-share mounts under it, see issue #72) or (b) nested per-share binds
# only; declaring it VOLUME would spawn a stray writable anonymous volume at the
# /sources root on every run.
# Bake an empty /sources dir so the directory always exists even when the operator
# only mounts NESTED per-share paths (e.g. /mnt/nas/photos:/sources/photos:ro)
# with no parent bind at /sources — the same layered mount layout documented for
# issue #72. (runc creates missing mountpoint dirs itself; this bake just makes
# /sources predictably present and empty rather than relying on that.)
RUN mkdir -p /sources
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -qO- http://localhost:3000/api/health || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "server.js"]

# Isolate SDK-only build inputs from the production CLI release.
FROM oven/bun:1.4.2 AS sdk-build
USER root
RUN apt-get update && apt-get install -y --no-install-recommends patch \
    && rm -rf /var/lib/apt/lists/*
ADD https://github.com/ProtonDriveApps/sdk.git#05c9115955589d9f6ab7392a36f8f0cb39327133 /opt/proton
WORKDIR /opt/proton/cli
# Rebase Proton's package mirror URLs onto public npm. The frozen lock still
# validates every tarball and applies Proton's OpenPGP patch.
RUN sed -i 's#https://pkg.protontech.ch/npm/npm-public/#https://registry.npmjs.org/#g' bun.lock \
    && bun install --production --frozen-lockfile --ignore-scripts \
    && ln -s cli/node_modules ../node_modules
# Expose the authenticated transport and caches already created by init().
COPY sdk-worker/init.patch /tmp/init.patch
RUN patch --directory=/opt/proton -p1 --fuzz=0 < /tmp/init.patch
COPY sdk-worker/*.ts src/backup-worker/
RUN CLI_VERSION=0.1.0-alpha JS_VERSION=0.23.0+05c91159 \
    bun scripts/build-cli.mjs src/backup-worker/worker.ts

# CI also checks the worker against the pinned SDK TypeScript declarations.
FROM sdk-build AS sdk-check
ENV DRIVE_SDK_WORKER=/opt/proton/cli/release/worker
RUN bun install --frozen-lockfile --ignore-scripts \
    && bun node_modules/typescript/bin/tsc --noEmit \
    && bun test src/backup-worker/*.test.ts

FROM runtime AS sdk-runner
RUN apt-get update && apt-get install -y --no-install-recommends pass gnupg \
    && rm -rf /var/lib/apt/lists/*
COPY --from=sdk-build /opt/proton/cli/release/worker /usr/local/bin/drive-sdk-worker
COPY --from=sdk-build /opt/proton/LICENSE.md /usr/share/doc/drive-sdk-worker/LICENSE
ENV DRIVE_BACKEND=sdk \
    DB_PATH=/data/sdk-backup.db \
    PROTON_DRIVE_CREDENTIALS_STORE=pass \
    PROTON_DRIVE_CACHE_DIR=/data/proton-sdk \
    HOME=/data/proton-sdk \
    GNUPGHOME=/keys

# Keep the unqualified build (including the release workflow) on the CLI.
FROM runtime AS production
COPY --from=cli /usr/local/bin/proton-drive /usr/local/bin/proton-drive
ENV PROTON_DRIVE_CLI=/usr/local/bin/proton-drive \
    PROTON_DRIVE_CACHE_DIR=/data/proton \
    PROTON_DRIVE_CREDENTIALS_STORE=unsafe_file
