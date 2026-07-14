# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: Build the Next.js app (standalone output)
# ---------------------------------------------------------------------------
FROM node:24-bookworm AS builder
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
ARG PROTON_CLI_VERSION=0.5.0
ARG PROTON_CLI_SHA512_X64=d85edbc57412c92a9705b70a8d3a5c66ad933331554d6b922b912d6df29b4e5e9b0d7a940a594927dd4788e1f8db86d5e9a23f084f07dbd5327f7a9e51d61272
ARG PROTON_CLI_SHA512_ARM64=a679e1e09d29413452a6ac24664dbd249bcafa1fb208e24b9c04133cd97488bf686d350cfcd2522742ac69de428142ac65cb56eb11f25260d3b4ffaa57d39054
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
FROM node:24-bookworm-slim AS production
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
RUN rm -rf src Dockerfile README.md docker-compose.yml docker-entrypoint.sh \
    tsconfig.json package-lock.json postcss.config.mjs .dockerignore

# proton-drive CLI
COPY --from=cli /usr/local/bin/proton-drive /usr/local/bin/proton-drive

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
    PROTON_DRIVE_CLI=/usr/local/bin/proton-drive \
    PROTON_DRIVE_CACHE_DIR=/data/proton \
    PROTON_DRIVE_UNSAFE_SECRETS=1 \
    PROTON_DRIVE_LOG_LEVEL=ERROR \
    CONFIG_DIR=/config \
    HOME=/data/proton

# Only /data is a managed volume. /sources is always supplied by the operator as
# (read-only) bind mounts; declaring it VOLUME would spawn a stray writable
# anonymous volume at the /sources root on every run.
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -qO- http://localhost:3000/api/health || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "server.js"]
