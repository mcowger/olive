# syntax=docker/dockerfile:1

FROM oven/bun:1.3.14 AS base
WORKDIR /app

# 1. Install system utilities and audio processing dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 2. Copy workspace package manifests to leverage Docker cache for dependencies
COPY package.json bun.lock ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/

# Install Node/Bun dependencies
RUN bun install --frozen-lockfile

# 3. Model Pre-download Layer
# (Positioned BEFORE copying application code so rebuilding code avoids redownloading model weights)
ENV HF_HOME=/app/.cache/huggingface \
    TRANSFORMERS_CACHE=/app/.cache/huggingface \
    OLIVE_CONFIG_DIR=/app/data/config

COPY scripts/download-models.ts ./scripts/
RUN bun run scripts/download-models.ts

# 4. Copy application source code
COPY tsconfig.json ./
COPY packages/shared ./packages/shared
COPY packages/server ./packages/server
COPY packages/web ./packages/web

# Build static web frontend
RUN bun run build:web

# 5. Production Runtime Configuration
ENV NODE_ENV=production \
    PORT=4470 \
    OLIVE_DATA_DIR=/app/data \
    OLIVE_CONFIG_DIR=/app/data/config \
    OLIVE_MEETINGS_DIR=/app/data/meetings \
    HF_HOME=/app/.cache/huggingface \
    TRANSFORMERS_CACHE=/app/.cache/huggingface

EXPOSE 4470

VOLUME ["/app/data"]

CMD ["bun", "run", "packages/server/src/index.ts"]
