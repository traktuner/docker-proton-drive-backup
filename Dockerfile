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
    PROTON_DRIVE_CREDENTIALS_STORE=unsafe_file \
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
